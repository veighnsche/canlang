/**
 * Vendor-tree staging unit spec (page-less, infra-free): `readVendorTree`
 * stages `.js` recursively with prefixed keys, excludes exact test-only
 * bridge keys (lane-B `work-loader.js` files carry `node:` imports that
 * trip the workerd link check), and fails loud on unmatched skips,
 * empty trees, and missing dists.
 */
import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readVendorTree } from "./vendor-trees.js";

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendor-walk-"));
  try {
    await mkdir(join(root, "dist", "fanout"), { recursive: true });
    await mkdir(join(root, "dist", "receipt"), { recursive: true });
    await writeFile(join(root, "dist", "keep.js"), "export const keep = 1;\n");
    await writeFile(join(root, "dist", "fanout", "work-loader.js"), "import 'node:url';\n");
    await writeFile(join(root, "dist", "receipt", "work-loader.js"), "import 'node:path';\n");
    await writeFile(join(root, "dist", "note.txt"), "ignored\n");
    return root;
  } catch (thrown) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // Preserve the setup failure even if cleanup also fails.
    }
    throw thrown;
  }
}

test("stages .js recursively with prefixed keys", async () => {
  const root = await makeTree();
  try {
    const modules = readVendorTree(join(root, "dist"), "vendor/state", "never");
    expect(Object.keys(modules).sort()).toEqual([
      "vendor/state/fanout/work-loader.js",
      "vendor/state/keep.js",
      "vendor/state/receipt/work-loader.js",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips exact test-only bridge keys", async () => {
  const root = await makeTree();
  try {
    const modules = readVendorTree(join(root, "dist"), "vendor/state", "never", [
      "fanout/work-loader.js",
      "receipt/work-loader.js",
    ]);
    expect(Object.keys(modules)).toEqual(["vendor/state/keep.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails loud on unmatched skips, empty trees, and missing dists", async () => {
  const root = await makeTree();
  try {
    expect(() => readVendorTree(join(root, "dist"), "vendor/state", "never", ["gone.js"])).toThrow(
      /vendor skip keys matched nothing.*gone\.js/,
    );
    expect(() =>
      readVendorTree(join(root, "dist"), "vendor/state", "never", [
        "keep.js",
        "fanout/work-loader.js",
        "receipt/work-loader.js",
      ]),
    ).toThrow(/no \.js modules found/);
    expect(() => readVendorTree(join(root, "missing"), "vendor/state", "bun run build")).toThrow(
      /missing not built; run `bun run build` first/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages declared contract imports without metadata or colocated tests", async () => {
  const root = await makeTree();
  try {
    await writeFile(join(root, "dist", "contract.js"), [
      'export { CSRF_FIELD } from "@canlang/contracts";',
      'import "@canlang/contracts";',
      'const contracts = import("@canlang/contracts");',
    ].join("\n"));
    await writeFile(join(root, "dist", "distribution.js"), 'export const directory = new URL("./", import.meta.url);');
    await writeFile(join(root, "dist", "contract.test.js"), 'import "node:test";');
    await writeFile(join(root, "dist", "receipt", "contract.js"), 'export { CSRF_FIELD } from "@canlang/contracts";');
    const modules = readVendorTree(pathToFileURL(join(root, "dist")), "vendor/ui", "never");
    expect(modules["vendor/ui/contract.js"]).toBe([
      'export { CSRF_FIELD } from "../contracts/index.js";',
      'import "../contracts/index.js";',
      'const contracts = import("../contracts/index.js");',
    ].join("\n"));
    expect(modules["vendor/ui/distribution.js"]).toBeUndefined();
    expect(modules["vendor/ui/contract.test.js"]).toBeUndefined();
    expect(modules["vendor/ui/receipt/contract.js"]).toBe('export { CSRF_FIELD } from "../../contracts/index.js";');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
