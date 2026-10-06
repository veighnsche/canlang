// Stage the committed, digest-pinned opt-in binding beside the emitted hosts.
// Backend selection remains explicit; staging never instantiates the module.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(pkg, "bindings", "generated");
const destination = join(pkg, "dist", "values", "bindings", "generated");
const inventoryBytes = readFileSync(join(source, "BUILD.json"));
const inventory = JSON.parse(inventoryBytes.toString("utf8"));
const names = [
  "values_semantics.d.ts",
  "values_semantics.js",
  "values_semantics_bg.wasm",
  "values_semantics_bg.wasm.d.ts",
];

if (Object.keys(inventory.files ?? {}).sort().join("\n") !== names.sort().join("\n")) {
  throw new Error("values semantics inventory does not match the expected binding files");
}

// Validate the complete source set before writing any of the installed copies.
const files = names.map((name) => {
  const bytes = readFileSync(join(source, name));
  const expected = inventory.files[name];
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (expected.bytes !== bytes.length || expected.sha256 !== digest) {
    throw new Error(`values semantics integrity mismatch: ${name}`);
  }
  return [name, bytes];
});

mkdirSync(destination, { recursive: true });
for (const [name, bytes] of files) writeFileSync(join(destination, name), bytes);
writeFileSync(join(destination, "BUILD.json"), inventoryBytes);
