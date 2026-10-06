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
import { readVendorTree } from "./vendor-trees.js";

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendor-walk-"));
  await mkdir(join(root, "dist", "fanout"), { recursive: true });
  await mkdir(join(root, "dist", "receipt"), { recursive: true });
  await writeFile(join(root, "dist", "keep.js"), "export const keep = 1;\n");
  await writeFile(join(root, "dist", "fanout", "work-loader.js"), "import 'node:url';\n");
  await writeFile(join(root, "dist", "receipt", "work-loader.js"), "import 'node:path';\n");
  await writeFile(join(root, "dist", "note.txt"), "ignored\n");
  return root;
}

test("stages .js recursively with prefixed keys", async () => {
  const root = await makeTree();
  try {
    const modules = readVendorTree(root, "dist", "vendor/state", "never");
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
    const modules = readVendorTree(root, "dist", "vendor/state", "never", [
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
    expect(() => readVendorTree(root, "dist", "vendor/state", "never", ["gone.js"])).toThrow(
      /vendor skip keys matched nothing.*gone\.js/,
    );
    expect(() =>
      readVendorTree(root, "dist", "vendor/state", "never", [
        "keep.js",
        "fanout/work-loader.js",
        "receipt/work-loader.js",
      ]),
    ).toThrow(/no \.js modules found/);
    expect(() => readVendorTree(root, "missing", "vendor/state", "bun run build")).toThrow(
      /missing not built; run `bun run build` first/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
