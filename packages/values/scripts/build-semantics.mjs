#!/usr/bin/env node
// Reproducible Wasm glue build for the values exact-semantics binding.
//
// 1. Asserts the wasm-bindgen CLI version matches the pinned crate version
//    in packages/values/Cargo.lock (bindgen requires exact equality).
// 2. cargo build --locked --target wasm32-unknown-unknown (release).
// 3. wasm-bindgen --target web into packages/values/bindings/generated/.
// 4. Writes bindings/generated/BUILD.json (versions, source hash, digests).
//
// The `web` target exposes initSync, so Node/Bun load local bytes and a
// Worker entry can pass its precompiled WebAssembly.Module: one artifact,
// three hosts, no async init, no network fetch. Package.json wiring of
// this script travels under the manifest handoff, not here.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const bindings = join(pkg, "bindings");
const generated = join(bindings, "generated");

function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, { encoding: "utf8", ...opts });
  return out === null ? "" : out.trim();
}

function lockVersion(name) {
  const lock = readFileSync(join(pkg, "Cargo.lock"), "utf8");
  const m = lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`));
  if (!m) throw new Error(`no ${name} entry in Cargo.lock`);
  return m[1];
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// 1. Pin check.
const want = lockVersion("wasm-bindgen");
let have;
try {
  have = run("wasm-bindgen", ["--version"]).split(" ").pop();
} catch (err) {
  throw new Error(`wasm-bindgen CLI missing (want ${want}); cargo install wasm-bindgen-cli --version ${want} --locked`);
}
if (have !== want) throw new Error(`wasm-bindgen CLI is ${have}, Cargo.lock pins ${want}`);

// 2. Wasm build.
run("cargo", ["build", "--locked", "--manifest-path", join(bindings, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"], { stdio: "inherit" });
const wasm = join(pkg, "target", "wasm32-unknown-unknown", "release", "values_bindings.wasm");
if (!existsSync(wasm)) throw new Error(`expected artifact missing: ${wasm}`);

// 3. Glue.
mkdirSync(generated, { recursive: true });
run("wasm-bindgen", [wasm, "--target", "web", "--out-dir", generated, "--out-name", "values_semantics"], { stdio: "inherit" });

// 4. Inventory.
const rustc = run("rustc", ["--version"]);
const sourceFiles = readdirSync(join(bindings, "src")).sort().map((f) => `src/${f}`);
const files = {};
for (const f of readdirSync(generated).sort()) {
  if (f === "BUILD.json") continue;
  files[f] = { sha256: sha256(join(generated, f)), bytes: readFileSync(join(generated, f)).length };
}
const inventory = {
  builder: "packages/values/scripts/build-semantics.mjs",
  rustc,
  wasm_bindgen: have,
  wasm_bindgen_crate: lockVersion("wasm-bindgen"),
  semantics_crate: "path ../semantics",
  target: "wasm32-unknown-unknown",
  profile: "release",
  bindgen_target: "web",
  sources: sourceFiles,
  files,
};
writeFileSync(join(generated, "BUILD.json"), JSON.stringify(inventory, null, 2) + "\n");

// 5. dist mirror: tsc emits bindings/*.js to dist/bindings/ but never
// copies the glue they import, so mirror generated/ alongside the emit.
// Full packaging/copy wiring is an A10 concern; this keeps the smoke test
// runnable with one documented ordering (build-semantics.mjs, then tests).
const mirror = join(pkg, "dist", "bindings", "generated");
mkdirSync(mirror, { recursive: true });
for (const f of readdirSync(generated).sort()) {
  writeFileSync(join(mirror, f), readFileSync(join(generated, f)));
}
console.log(`glue built: ${Object.keys(files).length} files in packages/values/bindings/generated/ (+ dist mirror)`);
