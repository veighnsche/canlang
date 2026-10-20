#!/usr/bin/env bun
// Targeted composition capture: compile the dependency closure of the
// named .can files with the same flags as the full 24-operand capture,
// then print a compact diagnostic summary. Iterative work should use
// this instead of the full capture; reserve the full 24-operand run
// for final confirmation.
//
// Usage:
//   bun scripts/capture.mjs [--list-only] [--out FILE] [--baseline FILE] <file...>
// Each <file> is a basename (CanRent, CanRent.can), a repo-relative path,
// or a package/app key (rent_catalog). Dependencies come from `uses=[...]`
// and `use NAME` declarations, closed transitively over provider files.
// Tokens with no provider file are reported as external and skipped.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const COMPILER = join(ROOT, "compiler/target/debug/can");
const CATALOG = "packages/values/dist/catalog.json";

const args = process.argv.slice(2);
const listOnly = args.includes("--list-only");
const outIdx = args.indexOf("--out");
const baseIdx = args.indexOf("--baseline");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const baseFile = baseIdx >= 0 ? args[baseIdx + 1] : null;
const targets = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--baseline");
if (targets.length === 0) {
  console.error("usage: bun scripts/capture.mjs [--list-only] [--out FILE] [--baseline FILE] <file...>");
  process.exit(2);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Generated contributions are build outputs resolved through the
      // generation root, never explicit compile operands.
      if (entry !== "can.generated") out = walk(full, out);
    } else if (entry.endsWith(".can")) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, "draft"));
const providers = new Map(); // key -> [files]
const depsOf = new Map(); // file -> [tokens]
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/^(?:package|app)\s+([A-Za-z_]\w*)/gm)) {
    const key = m[1];
    if (!providers.has(key)) providers.set(key, []);
    providers.get(key).push(file);
  }
  const deps = new Set();
  for (const m of src.matchAll(/uses=\[([^\]]*)\]/g))
    for (const tok of m[1].split(",")) {
      const t = tok.trim();
      if (t) deps.add(t);
    }
  for (const m of src.matchAll(/^\s*use\s+([A-Za-z_]\w*)/gm)) deps.add(m[1]);
  depsOf.set(file, [...deps]);
}

function resolveTarget(t) {
  const norm = t.replace(/\.can$/, "");
  const hits = files.filter(
    (f) => f.endsWith(sep + norm + ".can") || relative(ROOT, f) === norm || relative(ROOT, f) === norm + ".can",
  );
  if (hits.length > 0) return hits;
  if (providers.has(t) || providers.has(norm)) return providers.get(providers.has(t) ? t : norm);
  console.error(`no file or provider matches '${t}'`);
  process.exit(2);
}

const closure = new Set();
const queue = targets.flatMap(resolveTarget);
const external = new Set();
while (queue.length > 0) {
  const file = queue.pop();
  if (closure.has(file)) continue;
  closure.add(file);
  for (const tok of depsOf.get(file) ?? []) {
    if (providers.has(tok)) {
      for (const p of providers.get(tok)) queue.push(p);
    } else {
      external.add(tok);
    }
  }
}
const operands = [...closure].sort();
if (external.size > 0) console.error(`external tokens (no provider file): ${[...external].sort().join(", ")}`);
console.error(`closure: ${operands.map((f) => relative(ROOT, f)).join(" ")}`);
if (listOnly) process.exit(0);
if (!existsSync(COMPILER)) {
  console.error(`missing compiler binary: ${COMPILER} (cargo build first)`);
  process.exit(2);
}

// Operands stay repo-relative: the compiler resolves its generation root
// from them, and absolute paths change the capture identity.
const relOperands = operands.map((f) => relative(ROOT, f));
const run = spawnSync(
  COMPILER,
  ["compile", "--format=json", "--native-scenario-receipts", `--catalog=${CATALOG}`, ...relOperands],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
);
let artifact;
try {
  artifact = JSON.parse(run.stdout);
} catch {
  const toolErr = (run.stderr ?? "").trim().split("\n")[0] || `compiler exited ${run.status}`;
  console.error(`compiler failed: ${toolErr}`);
  process.exit(1);
}
if (outFile) writeFileSync(outFile, JSON.stringify(artifact));
const diags = artifact.diagnostics ?? [];
if (diags.length === 0 && !("diagnostics" in artifact)) {
  const js = (artifact.modules ?? []).map((m) => m.js ?? "").join("");
  const bindings = (js.match(/modelPolicyBindings:\[/g) ?? []).length;
  console.log(`clean: ${(artifact.modules ?? []).length} modules, native hook binding sites: ${bindings}`);
  console.log(`transitive loads: ${(js.match(/transitive\./g) ?? []).length}, records(c,: ${(js.match(/records\(c,/g) ?? []).length}`);
  process.exit(0);
}
console.log(`complete: ${artifact.complete} omitted: ${artifact.omitted} diags: ${diags.length}`);

const roots = new Map();
const perFile = new Map();
for (const d of diags) {
  const msg = (d.message ?? "").slice(0, 52);
  const key = `${d.code} ${msg}`;
  roots.set(key, (roots.get(key) ?? 0) + 1);
  const file = (d.primary?.file ?? -1) >= 0 ? (artifact.sources?.[d.primary.file]?.path ?? "?") : "?";
  const short = String(file).split("/").pop();
  perFile.set(short, (perFile.get(short) ?? 0) + 1);
}
console.log("--- roots ---");
for (const [k, v] of [...roots].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${v} ${k}`);
console.log("--- files ---");
for (const [k, v] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(`${v} ${k}`);

if (baseFile) {
  const base = JSON.parse(readFileSync(baseFile, "utf8"));
  const baseOps = new Set((base.sources ?? []).map((s) => s.path));
  const curOps = new Set(relOperands);
  const sameComposition =
    baseOps.size === curOps.size && [...baseOps].every((p) => curOps.has(p) || curOps.has(p.replace(/^\//, "")));
  if (!sameComposition) console.log("note: different composition than baseline; per-file deltas are directional only");
  const basePaths = new Map((base.sources ?? []).map((s) => [s.id, String(s.path ?? "?").split("/").pop()]));
  const basePer = new Map();
  for (const d of base.diagnostics ?? []) {
    const short = basePaths.get(d.primary?.file) ?? "??";
    basePer.set(short, (basePer.get(short) ?? 0) + 1);
  }
  console.log("--- delta vs baseline ---");
  let moved = false;
  for (const f of new Set([...basePer.keys(), ...perFile.keys()])) {
    const a = basePer.get(f) ?? 0;
    const b = perFile.get(f) ?? 0;
    if (a !== b) {
      moved = true;
      console.log(`${a} -> ${b}  ${f}`);
    }
  }
  if (!moved) console.log("no per-file movement");
  console.log(`total ${(base.diagnostics ?? []).length} -> ${diags.length}`);
}
