import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachBinaries, sha256Bytes, writeDeployBundleMixed, writeDeployBundleWithAssets,
} from "../src/deploy/bundle.js";
import type { DeployBundle, MixedDeployBundle } from "../src/deploy/bundle.js";

const bytes = new Uint8Array([0, 255, 128, 1]);
function text(modules: Record<string, string>): DeployBundle {
  return { mainModule: "a.js", modules, moduleCount: Object.keys(modules).length,
    sha256: "unchanged-text-digest", mcpBundleBytes: 0, httpOperationsBytes: 0 };
}
function fixture(parentKind: "text" | "binary", childKind: "text" | "binary", reverse: boolean): MixedDeployBundle {
  const modules: Record<string, string> = { "a.js": "EARLY" }, binaries: Record<string, Uint8Array> = {};
  const selected = [{ kind: parentKind, key: "branch" }, { kind: childKind, key: "branch/child.bin" }];
  for (const entry of reverse ? selected.reverse() : selected) {
    if (entry.kind === "text") modules[entry.key] = entry.key;
    else binaries[entry.key] = bytes;
  }
  return attachBinaries(text(modules), binaries);
}
function scratch(check: (output: string, outside: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "can-planned-output-")));
  const outside = join(root, "outside"); mkdirSync(outside);
  try { check(join(root, "output"), outside); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function expectUntouched(output: string, existing: boolean): void {
  if (!existing) expect(existsSync(output)).toBe(false);
  else {
    expect(readdirSync(output)).toEqual(["a.js"]);
    expect(readFileSync(join(output, "a.js"), "utf8")).toBe("prior producer bytes");
  }
}

describe("planned mixed output ancestry", () => {
  const cases = (["text", "binary"] as const).flatMap((parentKind) =>
    (["text", "binary"] as const).flatMap((childKind) =>
      [false, true].flatMap((reverse) => [false, true].map((existing) => ({ parentKind, childKind, reverse, existing })))));
  it.each(cases)("refuses $parentKind parent/$childKind child (reverse=$reverse, existing=$existing) before writes", ({ parentKind, childKind, reverse, existing }) => {
    scratch((output) => {
      if (existing) { mkdirSync(output); writeFileSync(join(output, "a.js"), "prior producer bytes"); }
      const selected = fixture(parentKind, childKind, reverse);
      // Attachment remains a snapshot/digest operation; planned paths refuse only at writer preflight.
      expect(selected.mixedSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(() => writeDeployBundleMixed(selected, output)).toThrow(/output "branch\/child.bin" has file\/directory collision with "branch"/);
      expectUntouched(output, existing);
    });
  });

  it("checks normalized ancestors while retaining raw keys in valid manifests", () => {
    scratch((output) => {
      const selected = attachBinaries(text({ "a.js": "EARLY", "folder/../branch": "PARENT" }), {
        "./branch//child.bin": bytes,
      });
      expect(() => writeDeployBundleMixed(selected, output)).toThrow(/file\/directory collision with "branch"/);
      expectUntouched(output, false);
    });
  });

  it.each((["branch/", "branch//"] as const).flatMap((parent) =>
    (["text", "binary"] as const).flatMap((parentKind) =>
      (["mixed", "package"] as const).map((writer) => ({ parent, parentKind, writer })))))(
    "checks trailing-slash $parent $parentKind parent for $writer without output effects", ({ parent, parentKind, writer }) => {
      scratch((output) => {
        const selected = attachBinaries(text(parentKind === "text" ? { "a.js": "EARLY", [parent]: "PARENT" } : { "a.js": "EARLY", "branch/child.bin": "CHILD" }),
          parentKind === "binary" ? { [parent]: bytes } : { "branch/child.bin": bytes });
        const write = () => writer === "mixed" ? writeDeployBundleMixed(selected, output) : writeDeployBundleWithAssets({
          ...selected, resources: {}, resourcesSha256: createHash("sha256").update(JSON.stringify({ version: 1, resources: [] })).digest("hex"),
        }, output);
        expect(write).toThrow(/has file\/directory collision with "branch"/);
        expectUntouched(output, false);
      });
    },
  );

  it.each(["mixed", "package"])("retains standalone trailing-slash native failure in %s", (writer) => {
    scratch((output) => {
      const selected = attachBinaries(text({ "a.js": "EARLY", "branch/": "STANDALONE" }), {});
      let error: unknown;
      try {
        if (writer === "mixed") writeDeployBundleMixed(selected, output);
        else writeDeployBundleWithAssets({ ...selected, resources: {}, resourcesSha256: createHash("sha256").update(JSON.stringify({ version: 1, resources: [] })).digest("hex") }, output);
      } catch (caught) { error = caught; }
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect(readFileSync(join(output, "a.js"), "utf8")).toBe("EARLY");
      expect(existsSync(join(output, "bundle.json"))).toBe(false);
    });
  });

  it.each(["bundle.json", "bundle.mixed.json"].flatMap((manifest) =>
    (["text", "binary"] as const).map((childKind) => ({ manifest, childKind }))))("includes $manifest as a planned file parent for $childKind", ({ manifest, childKind }) => {
    scratch((output) => {
      const child = `${manifest}/child.bin`;
      const selected = attachBinaries(text(childKind === "text" ? { "a.js": "EARLY", [child]: "CHILD" } : { "a.js": "EARLY" }), childKind === "binary" ? { [child]: bytes } : {});
      expect(() => writeDeployBundleMixed(selected, output)).toThrow(/has file\/directory collision/);
      expectUntouched(output, false);
    });
  });

  it("keeps valid sibling bytes, raw names, manifests and package-only names admitted in direct mixed", () => {
    scratch((output) => {
      const selected = attachBinaries(text({ "a.js": "EARLY", "./branch//left.js": "LEFT", "bundle.resources.json": "ordinary module" }), {
        "branch/right.bin": bytes,
      });
      const first = writeDeployBundleMixed(selected, output);
      const manifest = readFileSync(join(output, "bundle.json"), "utf8");
      expect(JSON.parse(manifest).modules).toContainEqual({ key: "./branch//left.js", bytes: 4 });
      expect(readFileSync(join(output, "bundle.resources.json"), "utf8")).toBe("ordinary module");
      expect([...readFileSync(join(output, "branch/right.bin"))]).toEqual([...bytes]);
      expect(writeDeployBundleMixed(selected, output)).toEqual(first);
      expect(readFileSync(join(output, "bundle.json"), "utf8")).toBe(manifest);
    });
  });

  it.each(["lexical", "alias", "reserved", "digest"])("keeps the existing %s refusal before planned ancestry and physical checks", (phase) => {
    scratch((output, outside) => {
      mkdirSync(output); writeFileSync(join(output, "a.js"), "prior producer bytes");
      writeFileSync(join(outside, "sentinel"), "outside bytes");
      symlinkSync(join(outside, "sentinel"), join(output, "bundle.mixed.json"));
      const selected = fixture("text", "binary", false);
      if (phase === "lexical") selected.modules["../escape"] = "bad";
      else if (phase === "alias") selected.modules["./branch"] = "alias";
      else if (phase === "reserved") selected.modules["bundle.json"] = "reserved";
      else selected.mixedSha256 = "changed";
      expect(() => writeDeployBundleMixed(selected, output)).toThrow(
        phase === "lexical" ? /outside the module map/ : phase === "alias" ? /aliases .* after normalization/ : phase === "reserved" ? /reserves writer manifest path/ : /mixed digest mismatch/,
      );
      expect(readFileSync(join(output, "a.js"), "utf8")).toBe("prior producer bytes");
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside bytes");
      expect(existsSync(join(output, "bundle.json"))).toBe(false);
    });
  });

  it("keeps the package resource layout refusal ahead of resource digest and physical output", () => {
    scratch((output) => {
      const resources = { "branch": { bytes, contentType: "text/css" } };
      const selected = { ...attachBinaries(text({ "a.js": "EARLY" }), { "branch/child.bin": bytes }), resources, resourcesSha256: "also-invalid" };
      expect(() => writeDeployBundleWithAssets(selected, output)).toThrow(/file\/directory collision with "branch"/);
      expectUntouched(output, false);
    });
  });

  it("keeps complete package writer resource bytes and package-only manifest reservation", () => {
    scratch((output) => {
      const resources = { "branch/style.css": { bytes, contentType: "text/css" } };
      const entries = [{ key: "branch/style.css", contentType: "text/css", bytes: bytes.length, sha256: sha256Bytes(bytes) }];
      const selected = { ...attachBinaries(text({ "a.js": "EARLY", "branch/left.js": "LEFT" }), { "branch/right.bin": bytes }), resources,
        resourcesSha256: createHash("sha256").update(JSON.stringify({ version: 1, resources: entries })).digest("hex") };
      const written = writeDeployBundleWithAssets(selected, output);
      expect([...readFileSync(join(output, "branch/style.css"))]).toEqual([...bytes]);
      expect(written.files).toContain(join(output, "bundle.resources.json"));
      selected.modules["bundle.resources.json"] = "reserved by package writer";
      expect(() => writeDeployBundleWithAssets(selected, output)).toThrow(/reserves writer manifest path/);
    });
  });
});
