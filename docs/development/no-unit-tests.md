# Banning unit tests

Unit testing is bureaucracy: mocks, stubs, and tests that mirror the
implementation cost maintenance on every refactor while proving little about
behavior users can observe. This project keeps integration and end-to-end
tests only, and enforces the ban at five independent layers so unit tests
cannot creep back in. Everything below is written to be copied into other
projects; SodaOS-specific paths are marked where they appear.

The rationale — the six reasons this is non-negotiable — lives in
[Why unit tests are forbidden](why-no-unit-tests.md), which every
enforcement layer cites on failure.

## The rule

A test is a **unit test** (banned) when it verifies code in isolation: pure
functions, fakes, stub servers, stub binaries, DOM shims. A test is
**integration/e2e** (kept) when it exercises real systems: a real database,
a real browser, real subprocesses, real builds, installed probes. Names lie:
a file called `*journey*` or a package called `acceptance` is still a unit
test if it runs on stubs. Classify by behavior, never by name.

## The layers

Each layer catches something the others miss:

| Layer | Catches | Runs on |
|---|---|---|
| Policy (`AGENTS.md`) | Tells humans and agents the rule | Every task |
| File gate (`check-no-unit-tests.sh`) | New test files; Rust test markers under `src/` | CI + local |
| Go vet analyzer (`tools/unitban`) | Test entry points *inside* allowlisted files; untracked files | CI + local |
| TS content linter (`check-ts-unitban.ts`) | Test-runner imports in prod code; bare test globals | Typecheck chain |
| Rust build ban (`build.rs` per crate) | Any `src/` test marker, on every cargo invocation | Every build |

The shell gate is fast and file-level. The Go analyzer is function-level
(the shell gate cannot see a unit test added to an allowlisted integration
file). The TS linter is content-level (oxlint has no custom-rule mechanism,
so this follows the `check-lit` custom-analyzer precedent). The Rust ban is
unskippable (stable rustc/clippy have no test-banning lints, so enforcement
happens at compile time instead).

## Adopting this in another project

1. **Inventory.** List every test file (`*_test.go`, `*.test.*`,
   `tests.rs`/`*_tests.rs`, inline `#[test]`/`#[cfg(test)]`).
2. **Classify by behavior.** Keep tests that need real systems; delete the
   rest. Delete stub-based "acceptance"/"journey" tests — the name does not
   promote them a tier.
3. **Keep the survivors compiling.** Kept tests often import helpers from
   deleted files: restore pure-helper files whole, and extract small fakes
   from deleted test files into new helper files. Never restore a file that
   contains test cases.
4. **Write the allowlists** (`tools/unitban/allow-go.txt`,
   `tools/unitban/allow-ts.txt`): exact paths of the kept test files, one
   per line, `#` comments allowed. Generate the initial lists from the
   deletion results.
5. **Install the five layers** below. Each ships with its own negative test.
6. **Delete the newly dead code.** Removing tests orphans product code only
   tests used. Follow the compiler's `dead_code` warnings, verify each item
   is unused by kept tests, and delete it. Expect some now-empty modules.
7. **Verify every layer both ways**: green on the clean tree, red on a
   planted violation. The sections below show how.

## Layer 0: policy

One bullet in `AGENTS.md`, next to the other testing guidance:

```md
- Unit testing is bureaucracy: never add unit tests. No new `*_test.go` or
  `*.test.ts` files, no `#[test]`/`#[cfg(test)]` in Rust `src/`, nothing the
  Go analyzer, TS guard, or Rust build ban flags. Verify through integration
  and end-to-end tests against real systems, and extend the `tools/unitban/`
  allowlists only for those.
```

## Layer 1: file gate

`scripts/check-no-unit-tests.sh` (adapt the crate roots and filename shapes
to your repo). It scans tracked files only, matching `git ls-files`
semantics: what is committed is what is gated. Wire it into whatever runs on
every push, next to the other negative gates.

```bash
#!/bin/bash
# No-unit-tests gate: unit testing is bureaucracy; integration and e2e only.
# Fails on (1) Rust test attributes or test-only modules under src/,
# (2) Go *_test.go files outside tools/unitban/allow-go.txt,
# (3) TS *.test.ts files outside tools/unitban/allow-ts.txt,
# (4) any *.test.js/*.test.mjs/*.test.jsx/*.spec.* files outside docs/examples/
# (docs/examples/ holds user-walkthrough fixtures executed in the reader's own
# disposable repo; they are content, not repo suites).
# New unit tests are banned by AGENTS.md. If a flagged file is genuinely
# integration/e2e tier (real PostgreSQL, real browser, real subprocesses),
# extend the matching allowlist and say why in the change.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# --- Rust: no test code under src/ (crate-top tests/ dirs are integration) ---
srcrs=$(git ls-files '*.rs' | grep -E '^(cmd|lib|tools)/[^/]+/src/' || true)
if [ -n "$srcrs" ]; then
  # shellcheck disable=SC2086
  hits=$(printf '%s\n' "$srcrs" | xargs grep -nE '#\[test\]|cfg\(test' -- || true)
  if [ -n "$hits" ]; then
    printf 'Rust test attributes under src/:\n%s\n' "$hits"
    fail=1
  fi
  hits=$(printf '%s\n' "$srcrs" | grep -E '/tests?\.rs$|/tests/|_tests\.rs$' || true)
  if [ -n "$hits" ]; then
    printf 'Rust test-only modules under src/:\n%s\n' "$hits"
    fail=1
  fi
  # shellcheck disable=SC2086
  hits=$(printf '%s\n' "$srcrs" | xargs grep -nE '^[[:space:]]*(pub[^;]*[[:space:]])?mod[[:space:]]+tests?[[:space:];]' -- || true)
  if [ -n "$hits" ]; then
    printf 'Rust test module declarations under src/:\n%s\n' "$hits"
    fail=1
  fi
fi

# --- Go: integration allowlist (exact paths) ---
gofiles=$(git ls-files '*_test.go' | sort || true)
if [ -n "$gofiles" ]; then
  hits=$(comm -23 <(printf '%s\n' "$gofiles") <(grep -vE '^\s*(#|$)' tools/unitban/allow-go.txt | sort -u) || true)
  if [ -n "$hits" ]; then
    printf 'Go test files outside the integration allowlist (unit tests are banned):\n%s\n' "$hits"
    fail=1
  fi
fi

# --- TS: browser-test allowlist (exact paths) ---
tsfiles=$(git ls-files '*.test.ts' '*.test.tsx' | sort || true)
if [ -n "$tsfiles" ]; then
  hits=$(comm -23 <(printf '%s\n' "$tsfiles") <(grep -vE '^\s*(#|$)' tools/unitban/allow-ts.txt | sort -u) || true)
  if [ -n "$hits" ]; then
    printf 'TS test files outside the browser-test allowlist (unit tests are banned):\n%s\n' "$hits"
    fail=1
  fi
fi

# --- Zero-tolerance test filename shapes ---
hits=$(git ls-files '*.test.js' '*.test.mjs' '*.test.jsx' '*.spec.ts' '*.spec.tsx' '*.spec.js' '*.spec.jsx' | grep -v '^docs/examples/' || true)
if [ -n "$hits" ]; then
  printf 'banned test filename shapes (unit tests are banned):\n%s\n' "$hits"
  fail=1
fi

# --- Hygiene: warn (do not fail) on stale allowlist entries ---
stale=$(comm -13 <(git ls-files '*.go' | sort) <(grep -vE '^\s*(#|$)' tools/unitban/allow-go.txt | sort -u) || true)
[ -n "$stale" ] && printf 'warning: stale Go allowlist entries (file deleted, list not pruned):\n%s\n' "$stale" >&2
stale=$(comm -13 <(git ls-files '*.ts' | sort) <(grep -vE '^\s*(#|$)' tools/unitban/allow-ts.txt | sort -u) || true)
[ -n "$stale" ] && printf 'warning: stale TS allowlist entries (file deleted, list not pruned):\n%s\n' "$stale" >&2

if [ "$fail" -ne 0 ]; then
  printf 'no-unit-tests gate failed. Unit tests are forbidden: see docs/development/why-no-unit-tests.md.\n'
  exit 1
fi
printf 'no-unit-tests gate passed: integration and e2e tests only.\n'
```

## Layer 2: Go vet analyzer

The file gate cannot see a unit test added to an *allowlisted* integration
file, and it only scans tracked files. The analyzer closes both gaps: it is
a `go vet` analyzer that flags test entry points in any file outside
`tools/unitban/allow-go.txt`, using type information so renames, aliases,
and dot-imports cannot evade it. Only top-level functions are flagged, which
mirrors exactly what `go test` runs (no suite framework in this repo could
execute test methods).

`tools/unitban/main.go` (needs `golang.org/x/tools`; the allowlist is
embedded so the binary is self-contained):

```go
// Command unitban is a go vet analyzer that bans unit tests.
//
// Unit testing is bureaucracy (AGENTS.md): test entry points (Test, Fuzz,
// Example, TestMain) may only exist in the integration-test files listed in
// tools/unitban/allow-go.txt. All other packages are production code.
//
// Self-test fixtures live in tools/unitban/testfixtures/ and are skipped by
// the analyzer; scripts/check-go-unitban.sh exercises the analyzer against a
// copy of the fixture outside the skipped directory.
package main

import (
	_ "embed"
	"flag"
	"go/ast"
	"go/types"
	"regexp"
	"strings"

	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/singlechecker"
)

//go:embed allow-go.txt
var embeddedAllow string

var extraAllow = flag.String("allow", "", "comma-separated extra allowlisted file paths (self-test override)")

var (
	testName = regexp.MustCompile(`^Test($|[^a-z])`)
	fuzzName = regexp.MustCompile(`^Fuzz($|[^a-z])`)
)

var analyzer = &analysis.Analyzer{
	Name: "unitban",
	Doc:  "unit tests are banned; test entry points only in allowlisted integration files",
	Run:  run,
}

func allowed(path string, allow map[string]bool) bool {
	for entry := range allow {
		if path == entry || strings.HasSuffix(path, "/"+entry) {
			return true
		}
	}
	return false
}

// testingParam reports whether fn's first parameter has the type ptrName
// from the testing package (e.g. *testing.T), resolved through type info so
// renames, aliases and dot imports are honored.
func testingParam(pass *analysis.Pass, fn *ast.FuncDecl, ptrName string) bool {
	if fn.Type.Params == nil || len(fn.Type.Params.List) == 0 {
		return false
	}
	typ := pass.TypesInfo.TypeOf(fn.Type.Params.List[0].Type)
	ptr, ok := typ.(*types.Pointer)
	if !ok {
		return false
	}
	named, ok := ptr.Elem().(*types.Named)
	if !ok || named.Obj().Name() != ptrName {
		return false
	}
	pkg := named.Obj().Pkg()
	return pkg != nil && pkg.Path() == "testing"
}

func run(pass *analysis.Pass) (any, error) {
	allow := map[string]bool{}
	for line := range strings.Lines(strings.TrimSpace(embeddedAllow)) {
		if p := strings.TrimSpace(line); p != "" && !strings.HasPrefix(p, "#") {
			allow[p] = true
		}
	}
	for p := range strings.SplitSeq(*extraAllow, ",") {
		if p = strings.TrimSpace(p); p != "" {
			allow[p] = true
		}
	}
	for _, file := range pass.Files {
		pos := pass.Fset.Position(file.Package)
		if strings.Contains(pos.Filename, "/testfixtures/") {
			continue
		}
		if allowed(pos.Filename, allow) {
			continue
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil {
				continue
			}
			name := fn.Name.Name
			banned := name == "TestMain" ||
				strings.HasPrefix(name, "Example") ||
				(testName.MatchString(name) && testingParam(pass, fn, "T")) ||
				(fuzzName.MatchString(name) && testingParam(pass, fn, "F"))
			if banned {
				pass.Reportf(fn.Pos(), "unit tests are banned (AGENTS.md): %s; see docs/development/why-no-unit-tests.md; integration tests live in allowlisted files (tools/unitban/allow-go.txt)", name)
			}
		}
	}
	return nil, nil
}

func main() { singlechecker.Main(analyzer) }
```

The analyzer cannot test itself with Go tests (a `_test.go` file would
violate its own ban), so it ships a fixture package and a shell-driven
self-test instead. `tools/unitban/testfixtures/unit.go`:

```go
// Package testfixtures carries the unitban analyzer's self-test fixture: a
// unit test the analyzer must flag. The analyzer skips this directory, so
// scripts/check-go-unitban.sh vets a copy staged outside it.
package testfixtures

import "testing"

func TestPlantedUnit(t *testing.T) {
	t.Log("flag me")
}

func ExamplePlanted() {}
```

`scripts/check-go-unitban.sh` builds the analyzer, runs the three-part
self-test (staged copy must fail, `-allow` override must pass, fixture
directory must pass via the skip), then vets `./...`:

```bash
#!/bin/bash
# Go unitban gate: runs the unitban vet analyzer (tools/unitban) over ./...
# plus the analyzer's self-test. Unit testing is bureaucracy (AGENTS.md):
# test entry points may only exist in tools/unitban/allow-go.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
export GOWORK=off GOFLAGS=-mod=readonly CGO_ENABLED=0 GOTOOLCHAIN=local GOOS=linux

mkdir -p .artifacts
vetbin=".artifacts/unitban-vettool.$$"
auditdir="tools/unitban/tmpaudit-$$"
cleanup() { rm -rf "$vetbin" "$auditdir"; }
trap cleanup EXIT

go build -mod=readonly -o "$vetbin" ./tools/unitban

# Self-test 1: a staged fixture copy outside the skipped directory must FAIL.
mkdir -p "$auditdir"
cp tools/unitban/testfixtures/unit.go "$auditdir"/
if go vet -mod=readonly -vettool="$PWD/$vetbin" "./$auditdir" >/dev/null 2>&1; then
  printf 'unitban self-test failed: planted unit test was not flagged\n' >&2
  exit 1
fi
# Self-test 2: the same copy with -allow must PASS (exemption works).
if ! go vet -mod=readonly -vettool="$PWD/$vetbin" -allow="$auditdir/unit.go" "./$auditdir" >/dev/null 2>&1; then
  printf 'unitban self-test failed: -allow exemption did not pass\n' >&2
  exit 1
fi
rm -rf "$auditdir"
# Self-test 3: the fixture directory itself must PASS (skip works).
if ! go vet -mod=readonly -vettool="$PWD/$vetbin" ./tools/unitban/testfixtures/ >/dev/null 2>&1; then
  printf 'unitban self-test failed: fixture skip broken\n' >&2
  exit 1
fi

# The gate: no test entry points outside the integration allowlist.
go vet -mod=readonly -vettool="$PWD/$vetbin" ./...
```

Note: through `go vet`, the analyzer's flag is passed as plain `-allow`
(verified empirically; `-unitban.allow` is rejected). Wire the script next
to the other gates so it runs on every push.

## Layer 3: TS content linter

oxlint has no custom-rule mechanism (verified against its configuration
schema), so TypeScript enforcement is a purpose-built AST linter following
this repo's `check-lit` precedent. It catches what the file gate cannot:
test-runner imports inside production code, and test definitions that do not
live in `*.test.ts` files. Rules, for files outside
`tools/unitban/allow-ts.txt`:

- **R1a** (under `tests/` or `*.test.ts`): value imports from test runners
  (`node:test`, `bun:test`, plus the well-known `vitest`/`jest`/`mocha`/
  `ava`/`tap`/`tape`/`uvu` families), except the lifecycle hooks
  `before`/`after`/`beforeEach`/`afterEach`/`beforeAll`/`afterAll` that
  browser-test drivers need. Type-only imports pass.
- **R1b** (everywhere else): any import from a test runner, hooks included.
- **R2** (under `tests/` or `*.test.ts`): calls to undeclared test globals
  (`test`, `describe`, `it`, `expect`, and the hooks), including focused
  `test.only(...)` forms. Locally declared names are excluded, so helpers
  that share a name do not trip the gate; comments and strings never match
  because the check is AST-based, not textual.

`scripts/check-ts-unitban.ts` (run with bun; `--self-test` runs inline
fixtures with no fixture files). It imports the classic TypeScript 5.9
compiler API from the copy `tools/lit-check` pins, because the root
TypeScript 7 native package no longer ships it — adapt this import to
whatever compiler API your project has:

```ts
// TS unitban: unit testing is bureaucracy (AGENTS.md). Fails on test-runner
// usage outside the allowlisted browser tests (tools/unitban/allow-ts.txt):
// R1a (tests/ or *.test.ts): value imports from test runners, except the
//     lifecycle hooks {before, after, beforeEach, afterEach, beforeAll,
//     afterAll} the kept browser drivers need. Type-only imports pass.
// R1b (all other .ts): any import from a test runner, hooks included.
// R2 (tests/ or *.test.ts): calls to undeclared test globals
//     {test, describe, it, expect, before, after, beforeEach, afterEach,
//     beforeAll, afterAll}. Locally declared names are excluded, so helper
//     functions that happen to share a name do not trip the gate.
// Run `bun scripts/check-ts-unitban.ts --self-test` for inline fixtures.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
// Classic compiler API (root typescript is v7 native without it); shared
// with tools/lit-check, which pins this copy.
import * as ts from '../tools/lit-check/node_modules/typescript/lib/typescript.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ALLOW = `${ROOT}/tools/unitban/allow-ts.txt`;
const RUNNERS = new Set([
  'node:test',
  'node:test/reporters',
  'bun:test',
  'vitest',
  'jest',
  '@jest/globals',
  'mocha',
  'ava',
  'tap',
  'tape',
  'uvu',
]);
const HOOKS = new Set(['before', 'after', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const GLOBALS = new Set(['test', 'describe', 'it', 'expect', ...HOOKS]);
const DEFINERS = new Set(['test', 'describe', 'it']);

interface Finding {
  path: string;
  line: number;
  rule: string;
  text: string;
}

function inTestScope(path: string): boolean {
  return path.startsWith('tests/') || path.endsWith('.test.ts') || path.endsWith('.test.tsx');
}

function declaredNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      names.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    } else if (ts.isImportSpecifier(node)) {
      names.add(node.name.text);
    } else if (ts.isImportClause(node) && node.name !== undefined) {
      names.add(node.name.text);
    } else if (ts.isNamespaceImport(node)) {
      names.add(node.name.text);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function findingsFor(path: string, text: string, allow: Set<string>): Finding[] {
  const findings: Finding[] = [];
  if (allow.has(path)) return findings;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const scope = inTestScope(path);

  const checkImport = (module: string, node: ts.Node, names: string[], typeOnly: boolean): void => {
    if (!RUNNERS.has(module)) return;
    if (!scope) {
      findings.push({path, line: lineOf(node), rule: 'R1b', text: `test-runner import '${module}' outside tests/`});
      return;
    }
    for (const name of names) {
      if (typeOnly || HOOKS.has(name)) continue;
      findings.push({path, line: lineOf(node), rule: 'R1a', text: `test-runner import '${name}' from '${module}'`});
    }
    if (names.length === 0 && !typeOnly) {
      findings.push({path, line: lineOf(node), rule: 'R1a', text: `test-runner import from '${module}'`});
    }
  };

  const declared = declaredNames(source);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause === undefined) {
        checkImport(module, node, [], false);
      } else if (clause.isTypeOnly) {
        return;
      } else if (clause.namedBindings === undefined) {
        if (clause.name !== undefined) checkImport(module, node, [clause.name.text], false);
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        checkImport(module, node, [], false);
      } else {
        const names = clause.namedBindings.elements
          .filter((e) => !e.isTypeOnly)
          .map((e) => (e.propertyName !== undefined ? e.propertyName.text : e.name.text));
        checkImport(module, node, names, names.length === 0 && clause.namedBindings.elements.length > 0);
      }
    } else if (
      scope &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBALS.has(node.expression.text) &&
      !declared.has(node.expression.text)
    ) {
      findings.push({path, line: lineOf(node), rule: 'R2', text: `bare test-global call '${node.expression.text}(...)'`});
    } else if (
      scope &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      DEFINERS.has(node.expression.expression.text) &&
      !declared.has(node.expression.expression.text)
    ) {
      findings.push({path, line: lineOf(node), rule: 'R2', text: `bare test-global call '${node.expression.expression.text}.${node.expression.name.text}(...)'`});
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteral(first) && RUNNERS.has(first.text)) {
        findings.push({path, line: lineOf(node), rule: scope ? 'R1a' : 'R1b', text: `test-runner require('${first.text}')`});
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

async function loadAllow(): Promise<Set<string>> {
  const text = await readFile(ALLOW, 'utf8');
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
}

async function main(): Promise<void> {
  const allow = await loadAllow();
  const proc = Bun.spawnSync(['git', 'ls-files', '*.ts'], {cwd: ROOT});
  if (proc.exitCode !== 0) throw new Error('git ls-files failed');
  const files = proc.stdout.toString().trim().split('\n').filter((f) => f !== '');
  const findings: Finding[] = [];
  for (const path of files) {
    const text = await readFile(`${ROOT}/${path}`, 'utf8');
    findings.push(...findingsFor(path, text, allow));
  }
  if (findings.length > 0) {
    for (const f of findings) console.log(`${f.path}:${f.line}: [${f.rule}] ${f.text}`);
    console.log(`ts-unitban failed: ${findings.length} finding(s). Unit tests are banned (AGENTS.md); see docs/development/why-no-unit-tests.md.`);
    process.exit(1);
  }
  console.log(`ts-unitban passed: no test-runner usage outside ${allow.size} allowlisted files.`);
}

function selfTest(): void {
  const allow = new Set(['tests/keep.test.ts']);
  const cases: [string, string, string, number][] = [
    ['R1a import', 'tests/fake.test.ts', `import test from 'node:test';\ntest('x', () => {});`, 1],
    ['R1a hooks pass', 'tests/fix.ts', `import {before, after} from 'node:test';\nbefore(() => {});`, 0],
    ['R1a type-only pass', 'tests/fix.ts', `import type {TestContext} from 'node:test';\nconst x: TestContext | null = null;`, 0],
    ['R1a namespace', 'tests/fake.test.ts', `import * as t from 'node:test';\nconsole.log(t);`, 1],
    ['R1b prod import', 'frontend/x.ts', `import {test} from 'node:test';\nconsole.log(test);`, 1],
    ['R1b prod hooks', 'frontend/x.ts', `import {before} from 'node:test';\nconsole.log(before);`, 1],
    ['R2 bare call', 'tests/y.ts', `test('x', () => {});`, 1],
    ['R2 allowlisted', 'tests/keep.test.ts', `test('x', () => {});`, 0],
    ['R2 declared local', 'tests/y.ts', `function test() {}\ntest();`, 0],
    ['R2 method call', 'tests/y.ts', `const o = {test() {}};\no.test();`, 0],
    ['R2 focused', 'tests/y.ts', `test.only('x', () => {});`, 1],
    ['R2 comment+string', 'tests/y.ts', `// test(\nconst s = "test(";\nconsole.log(s);`, 0],
    ['R1a require', 'tests/y.ts', `const t = require('node:test');\nconsole.log(t);`, 1],
  ];
  for (const [name, path, text, want] of cases) {
    const got = findingsFor(path, text, allow).length;
    assert.equal(got, want, `${name}: want ${want}, got ${got}`);
  }
  console.log(`ts-unitban self-test passed: ${cases.length} cases.`);
}

if (import.meta.main) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    await main();
  }
}
```

Wire it next to the other checks (here: two `package.json` scripts,
`check:ts-unitban` and `test:ts-unitban`, appended to the `typecheck`
chain, mirroring `check:lit`/`test:lit-check`).

## Layer 4: Rust compile-time ban

Stable rustc and clippy have no test-banning lints (verified against both
lint lists), and out-of-tree lint drivers need nightly, so Rust enforcement
happens at compile time instead: every workspace member gets a `build.rs`
that fails the build when unit-test markers appear under its `src/`. This
fires on every `cargo build`, `check`, `test`, and `clippy` invocation, and
in IDEs via rust-analyzer — it cannot be skipped by forgetting to run a
gate. No manifest changes are needed: cargo auto-detects `build.rs`.

To avoid 28 copies of the scan, the logic lives in one shared file pulled
in with `include!` (uniform here because every member sits exactly two
levels deep; adjust the relative path otherwise).
`tools/unitban/build_impl.rs`:

```rust
// Shared compile-time unit-test ban (AGENTS.md): unit testing is bureaucracy.
// Included by every workspace member's build script; integration tests live
// in crate-top tests/ only. Fails the build if unit-test markers appear
// under the including crate's src/.
fn unitban_visit(dir: &std::path::Path, under_tests: bool, bad: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default();
            if name == "tests" {
                bad.push(format!("{}: test-only directory", path.display()));
            }
            unitban_visit(&path, under_tests || name == "tests", bad);
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }
        if under_tests {
            bad.push(format!(
                "{}: file under test-only directory",
                path.display()
            ));
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default();
        if name == "tests.rs" || name.ends_with("_tests.rs") {
            bad.push(format!("{}: test-only module", path.display()));
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (n, line) in text.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            if code.contains("#[test]") || code.contains("cfg(test") {
                bad.push(format!("{}:{}: {}", path.display(), n + 1, code.trim()));
            }
        }
    }
}

fn deny_unit_tests() {
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../../tools/unitban/build_impl.rs");
    let mut bad = Vec::new();
    unitban_visit(std::path::Path::new("src"), false, &mut bad);
    assert!(
        bad.is_empty(),
        "unit tests are banned (AGENTS.md; why: docs/development/why-no-unit-tests.md); integration tests live in tests/:\n{}",
        bad.join("\n")
    );
}
```

Each member's `build.rs` is then just:

```rust
// Compile-time unit-test ban (AGENTS.md): unit testing is bureaucracy.
// Logic lives in tools/unitban/build_impl.rs, shared by every member.
include!("../../tools/unitban/build_impl.rs");

fn main() {
    deny_unit_tests();
}
```

Crates that already have a build script keep it and call
`deny_unit_tests()` from `main`. Full-line `//` comments are skipped so a
commented-out test (or a comment discussing the ban) does not trip the
build. The explicit `rerun-if-changed` on the shared file was verified to
retrigger builds when the ban logic itself changes.

## Removing the tests in the first place

Two scripts did the mechanical work here (kept out of the repo; ask or
recreate per the recipes below):

- A Rust stripper that removed `#[cfg(test)]` items (module decls and
  blocks, test-only imports, helpers, struct fields, statements) and free
  `#[test]` functions, with a brace matcher that understands strings,
  comments, chars, and raw strings. Hard-won lessons: never decide
  block-vs-statement by offset comparison (generic-arg commas like
  `Result<(), String>` in `fn` signatures misroute to statement mode —
  dispatch on the leading keyword instead), and absorb stacked attributes
  *and* `///` doc comments above removed items (an orphaned `///` is a
  hard E0585 error or, worse, silently mis-documents the next item).
- A dead-code deleter driven by `cargo check --message-format json`
  `dead_code` warnings, deleting dead functions, consts, statics, structs
  (with their same-crate impls), and enums. Guards that proved necessary:
  never delete struct fields or enum variants (too invasive), never touch
  items referenced by kept integration tests (one near-miss: a dead bin
  helper sharing a name with a live lib helper the tests used), and never
  touch `pub use` re-exports flagged only in test profiles (live public
  API that merely looks unused where integration tests include sources
  directly).

Deleting tests orphans product code only tests used. After the deletion,
work through the compiler's `dead_code` warnings with the guards above;
expect some modules to empty out entirely (delete the module and its `mod`
declaration together).

## Verifying a layer

Every layer above was verified in both directions before landing:

1. Green on the clean tree (the layer's own check passes with no findings).
2. Red on a planted violation (add the smallest banned shape, watch the
   exact layer fail with a file:line report, remove the plant).

Plants used here: a `#[test]` fn and a `src/tests.rs` file (file gate +
  Rust ban), a `mod tests;` declaration (file gate), a `func TestX` in a
non-allowlisted package (Go analyzer), a `node:test` import in a new
`.test.ts` (TS linter + file gate), and a `*.spec.ts` file (filename ban).

## Limits and maintenance

- Allowlists are the friction point by design: adding a genuine
  integration test means extending `tools/unitban/allow-{go,ts}.txt` with
  a comment justifying the tier. Review those diffs; that review *is* the
  enforcement for cases no pattern can express (such as a unit-style test
  added inside an allowlisted file — the Go analyzer narrows but cannot
  close that gap, since kept integration files legitimately contain `Test`
  functions).
- The shell gate scans tracked files (`git ls-files` semantics): it gates
  what is committed, authoritatively in CI. The Go analyzer scans the
  worktree, so it also catches untracked files locally.
- Test *fixtures* and *testdata* were deliberately left alone unless
  provably orphaned: data files are not tests, and deleting shared fixtures
  breaks kept integration suites. Revisit per case.
- Unused test frameworks may linger as dependencies after the deletion
  (here: `testify`); `go mod tidy` / dependency pruning is a separate
  follow-up.
- Shell has no test framework to ban and Python is banned entirely by the
  existing `check-no-python.sh`, so neither language needs a unitban layer.

