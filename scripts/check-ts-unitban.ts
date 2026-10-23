// Content gate for the AGENTS.md unit-test ban: production TypeScript must
// not import test runners. Test files (*.test.ts, *.spec.ts, *.pending.ts,
// *.wasm-test.ts) and the test-infrastructure paths in
// tools/unitban/allow-runner-imports.txt may import runners freely.
// Run: bun scripts/check-ts-unitban.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// Runner runtime modules. `vitest/config` is deliberately absent: it is build
// configuration, not a test runner.
const BANNED = new Set([
  "vitest",
  "vitest/node",
  "node:test",
  "bun:test",
  "@playwright/test",
]);
const BANNED_PREFIX = "@vitest/";

const TEST_FILE = /\.(test|spec|pending|wasm-test)\.ts$/;

function listFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "*.ts", "*.mts", "*.cts"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const tracked = out.split("\0").filter(Boolean);
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "*.ts", "*.mts", "*.cts"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  // A removed tracked source still appears in the index until it is staged.
  // Scan the actual working tree, including new files, without opening retired paths.
  const deleted = new Set(execFileSync(
    "git", ["ls-files", "--deleted", "-z"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\0").filter(Boolean));
  return [...tracked, ...untracked].filter((path) => !deleted.has(path));
}

function loadInfraAllowlist(): string[] {
  return readFileSync(`${ROOT}/tools/unitban/allow-runner-imports.txt`, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

function isInfra(path: string, allow: string[]): boolean {
  if (path.startsWith("docs/")) return true; // frozen artifacts, not shipped code
  if (TEST_FILE.test(path)) return true;
  return allow.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}

function bannedSpecifier(spec: string): boolean {
  return BANNED.has(spec) || spec.startsWith(BANNED_PREFIX);
}

function checkFile(path: string): string[] {
  const full = `${ROOT}/${path}`;
  const text = readFileSync(full, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteralLike(spec) && bannedSpecifier(spec.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        hits.push(`${path}:${line + 1}: ${spec.text}`);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      bannedSpecifier(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      hits.push(`${path}:${line + 1}: dynamic import ${node.arguments[0].text}`);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      bannedSpecifier(node.arguments[0].text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      hits.push(`${path}:${line + 1}: require ${node.arguments[0].text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

const allow = loadInfraAllowlist();
const bad: string[] = [];
let scanned = 0;
for (const path of listFiles()) {
  if (isInfra(path, allow)) continue;
  scanned++;
  bad.push(...checkFile(path));
}
if (bad.length > 0) {
  console.error(
    "ts unit-test content gate FAILED: test-runner imports in production code:",
  );
  for (const hit of bad) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`ts unit-test content gate: OK (${scanned} production files scanned)`);
