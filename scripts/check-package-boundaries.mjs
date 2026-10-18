#!/usr/bin/env node
/**
 * Read-only workspace guard. Run after installing and building the producers.
 * Checks JS/TS module edges, known constant module/path expressions, export
 * targets, owning dependency declarations, production/development separation,
 * and the complete local manifest graph (including dev dependencies).
 * --audit lists expressions requiring runtime/context review. This is not a
 * general filesystem, shell, YAML, Rust, or generated-module-string analyzer.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const OMIT = new Set(['dist', 'node_modules', 'target', '.git', '.turbo']);
const DEPENDENCIES = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const PRODUCTION_DEPENDENCIES = DEPENDENCIES.filter(section => section !== 'devDependencies');
const DEPENDENCY_ERRORS = new Set(['unknown-workspace-dependency', 'workspace-version', 'dependency-cycle',
  'undeclared-dependency', 'production-dev-dependency', 'unknown-local-package']);
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const ROOT_AREAS = ['tests', 'tools', 'scripts', '.github'];

// These exact resolver calls discover caller-provided/optional producers. They
// are not static imports and must retain their existing unavailable/error path.
// Browser tools are separately provisioned development tools, never an implicit
// requirement of the production installation.
export const contextualModuleLocators = [
  { consumer: 'packages/cloudflare/src/runtime/example-bindings.ts', specifier: '@canlang/testkit', reason: 'Optional caller/host inline-example semantic producer; a direct dependency would cycle.' },
  { consumer: 'packages/cloudflare/src/generation/acceptance.ts', specifier: '@playwright/test/cli', reason: 'Mandatory browser acceptance requires explicit development-tool setup and fails when absent.' },
  { consumer: 'packages/testkit/src/browser/chromium.ts', specifier: '@playwright/test', reason: 'Optional browser producer reports unavailable when the development driver is absent.' },
  { consumer: 'packages/cloudflare/test/first-profile-browser.integration.test.ts', specifier: '@canlang/testkit/browser/chromium', reason: 'The integration test selects the browser producer from its explicit fixture project.' },
];

function productionSource(file, consumer, rootPackage) {
  if (consumer === rootPackage) return false;
  const relative = path.relative(consumer.directory, file).split(path.sep).join('/');
  return !relative.split('/').some(part => ['test', 'tests', '__tests__', 'conformance', 'scripts'].includes(part)) &&
    !/\.(?:test|spec|wasm-test)\.[cm]?[jt]sx?$/.test(relative);
}

function typeOnlyModule(node) {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly ||
    (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly));
  const clause = node.importClause;
  return clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly));
}

// Checkout inputs are deliberately separate from package API exceptions.
// These registrations document context-dependent release/e2e reads; they do
// not allow JavaScript imports into sibling source trees.
export const checkoutInputs = [
  { consumer: 'packages/cloudflare/src/cli/native-handoff.ts', target: 'dev-server/host/entry.mjs', reason: 'Source-checkout native handoff selects the fixed SDK host; installed use supplies its bundled host.' },
  { consumer: 'packages/cloudflare/test/local-run-lifecycle.test.ts', target: 'tests/integration/can-dev-server/ModelFreePreview.can', reason: 'The native lifecycle test copies this exact source into its isolated application before checking real owned Workerd processes.' },
  { consumer: 'packages/cloudflare/src/release/stamp.ts', target: 'compiler/Cargo.toml', reason: 'Release lockstep reads the owning compiler version.' },
  { consumer: 'tests/e2e/fixtures/artifact-loader.ts', target: 'caller-supplied .can fixtures', reason: 'The compiled mode hands explicit fixture paths to the compiler; shell/native execution is outside this AST guard.' },
  { consumer: 'packages/cloudflare/test/compiler-check.integration.test.ts', target: 'tests/integration/can-dev-server/OfficeSupplies.can', reason: 'The compiler integration test reads this declared example fixture.' },
  { consumer: 'packages/cloudflare/test/committed-model-consumer.test.ts', target: 'compiler/tests/fixtures/committed_change.can', reason: 'The native committed-model test reads the owning Compiler fixture for its explicitly derived CRUD composition.' },
  { consumer: 'packages/cloudflare/test/native-table-time-page.test.ts', target: 'compiler/tests/fixtures/table-time.can', reason: 'The genuine TableTime full/partial HTTP test reads the owning Compiler source fixture for original query-time pagination and continuation assertions.' },
  { consumer: 'packages/cloudflare/test/native-callback-diagnostics.test.ts', target: 'compiler/tests/fixtures/callback-diagnostics.can', reason: 'The genuine native callback-history qualifier reads the owning Compiler source fixture to verify original source correspondence before compiling its declared CRUD composition.' },
  { consumer: 'packages/cloudflare/test/native-first-budget.test.ts', target: 'compiler/tests/fixtures/native-first-budget.can', reason: 'The original First and source-rule CRUD qualifiers hash the owning Compiler fixture and verify exact source restoration after stripping only labelled authenticated setup.' },
  { consumer: 'packages/cloudflare/test/native-protected-poll-browser.test.ts', target: 'compiler/tests/fixtures/view-reuse.can', reason: 'The emitted protected-action browser test hashes the owning Compiler view fixture and verifies its exact restoration after adding only a test poll interval.' },
  { consumer: 'packages/cloudflare/test/composed-owner-policy.test.ts', target: 'compiler/tests/model_rule_origins.rs', reason: 'The composed owner-policy test extracts the exact original Compiler declarations and verifies that only labelled authenticated CRUD setup is added.' },
  { consumer: 'packages/cloudflare/src/runtime/native-local-rules.integration.test.ts', target: 'compiler/tests/fixtures/hook_order_rollback.can', reason: 'The native local-rules test reads the owning Compiler fixture for its actual hook-order and rollback consumer.' },
  { consumer: 'packages/cloudflare/src/runtime/native-local-rules-d1.integration.test.ts', target: 'compiler/tests/fixtures/hook_order_rollback.can', reason: 'The portable D1 local-rules test reads the owning Compiler fixture for its actual hook-order and rollback consumer.' },
  { consumer: 'packages/cloudflare/src/runtime/native-local-rules-d1.integration.test.ts', target: 'compiler/tests/fixtures/anonymous-message-consumer.mjs', reason: 'The portable D1 Node URL test reads the owning Compiler consumer fixture to extract its complete original URL source and verify source-current equality.' },
  { consumer: 'packages/state/test/file-retirement-storage.test.ts', target: 'packages/cloudflare/test/fixtures/typed-images-progress.can', reason: 'The opaque retirement storage test compiles the complete owning typed Images fixture to check persisted File correspondence.' },
  { consumer: 'packages/work/test/file-retirement-framework.test.ts', target: 'packages/cloudflare/test/fixtures/typed-images-progress.can', reason: 'The opaque retirement framework test compiles the complete owning typed Images fixture to check Work File correspondence.' },
];

function inside(file, directory) {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (OMIT.has(entry.name) || entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(file) : SOURCE.test(entry.name) ? [file] : [];
  });
}

function workspaceDirs(root, patterns) {
  return [...new Set(patterns.flatMap(pattern => {
    if (typeof pattern !== 'string' || pattern.includes('**') || pattern.includes('!')) throw new Error(`Unsupported workspace pattern ${JSON.stringify(pattern)}`);
    return pattern.split('/').reduce((dirs, segment) => dirs.flatMap(dir => {
      if (segment !== '*') return [path.join(dir, segment)];
      return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name));
    }), [root]).filter(dir => existsSync(path.join(dir, 'package.json')));
  }))];
}

function exportMatch(manifest, subpath) {
  const exports = manifest.exports;
  if (exports === undefined) return undefined;
  if (typeof exports === 'string' || exports === null || Array.isArray(exports) || !Object.keys(exports).some(key => key.startsWith('.'))) {
    return subpath === '.' ? exports : undefined;
  }
  if (Object.hasOwn(exports, subpath)) return exports[subpath];
  const patterns = Object.keys(exports).filter(key => key.includes('*')).sort((a, b) => b.length - a.length);
  for (const key of patterns) {
    const [prefix, suffix] = key.split('*');
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const capture = subpath.slice(prefix.length, subpath.length - suffix.length || undefined);
      const replace = value => typeof value === 'string' ? value.replaceAll('*', capture) : Array.isArray(value) ? value.map(replace) : value && Object.fromEntries(Object.entries(value).map(([name, child]) => [name, replace(child)]));
      return replace(exports[key]);
    }
  }
  return undefined;
}

function targets(value) {
  if (typeof value === 'string') return [value];
  if (!value) return [];
  return (Array.isArray(value) ? value : Object.values(value)).flatMap(targets);
}

function runtimeTarget(value) {
  if (typeof value === 'string') return value;
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(runtimeTarget).find(Boolean);
  return runtimeTarget(value.import ?? value.default ?? value.node ?? value.require);
}

function matchesPathAlias(config, specifier) {
  return Object.keys(config.options.paths ?? {}).some(pattern => {
    const wildcard = pattern.indexOf('*');
    if (wildcard < 0) return pattern === specifier;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length;
  });
}

function reverseMappedSources(producer, target, config) {
  const rootDir = config.options.rootDir;
  const outDir = config.options.outDir;
  if (!rootDir || !outDir) return [];
  const sourceRoot = path.resolve(rootDir);
  const outputRoot = path.resolve(outDir);
  const output = path.resolve(producer.directory, target);
  if (!inside(output, outputRoot)) return [];
  const relative = path.relative(outputRoot, output);
  const replacements = [
    [/\.d\.mts$/, ['.mts']], [/\.d\.cts$/, ['.cts']], [/\.d\.ts$/, ['.ts']],
    [/\.mjs$/, ['.mts']], [/\.cjs$/, ['.cts']], [/\.jsx$/, ['.tsx', '.jsx']], [/\.js$/, ['.ts', '.tsx', '.js']],
  ];
  const match = replacements.find(([suffix]) => suffix.test(relative));
  if (!match) return [];
  const stem = relative.replace(match[0], '');
  return match[1].map(extension => path.resolve(sourceRoot, `${stem}${extension}`))
    .filter(source => inside(source, sourceRoot) && config.fileNames.includes(source));
}

export function checkPackageBoundaries(rootDirectory, { dependenciesOnly = false } = {}) {
  const root = realpathSync(rootDirectory);
  const readManifest = directory => ({ directory, file: path.join(directory, 'package.json'), manifest: JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) });
  const rootPackage = readManifest(root);
  const patterns = rootPackage.manifest.workspaces;
  if (!Array.isArray(patterns)) throw new Error('The root manifest must declare a workspace array.');
  const packages = workspaceDirs(root, patterns).map(readManifest);
  const byName = new Map(packages.map(pkg => [pkg.manifest.name, pkg]));
  if (byName.size !== packages.length) throw new Error('Workspace package names must be unique.');
  const owner = file => packages.find(pkg => inside(file, pkg.directory)) ?? rootPackage;
  const errors = [];
  const unresolved = [];
  const registered = [];
  const seen = new Set();
  const report = (code, file, node, message) => {
    if (dependenciesOnly && !DEPENDENCY_ERRORS.has(code)) return;
    const source = node?.getSourceFile();
    const position = source && source.getLineAndCharacterOfPosition(node.getStart(source));
    const entry = { code, file: path.relative(root, file).split(path.sep).join('/'), line: position ? position.line + 1 : 1, message };
    const key = JSON.stringify(entry);
    if (!seen.has(key)) { seen.add(key); errors.push(entry); }
  };

  const graph = new Map();
  for (const pkg of [rootPackage, ...packages]) {
    const edges = new Set();
    for (const section of DEPENDENCIES) for (const [name, version] of Object.entries(pkg.manifest[section] ?? {})) {
      if (!byName.has(name)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) report('unknown-workspace-dependency', pkg.file, undefined, `${section}.${name} has no owning workspace manifest.`);
        continue;
      }
      edges.add(name);
      if (version !== 'workspace:*') report('workspace-version', pkg.file, undefined, `${section}.${name} must use workspace:* (found ${JSON.stringify(version)}).`);
    }
    if (pkg !== rootPackage) graph.set(pkg.manifest.name, [...edges].sort());
    for (const target of targets(pkg.manifest.exports)) {
      if (target.includes('*')) continue; // Concrete wildcard imports are validated below.
      const file = path.resolve(pkg.directory, target);
      if (!target.startsWith('./') || !inside(file, pkg.directory)) report('export-target', pkg.file, undefined, `Export target ${JSON.stringify(target)} escapes its owning package.`);
      else if (!existsSync(file)) report('missing-export-target', pkg.file, undefined, `Export target ${JSON.stringify(target)} does not exist; build its producer.`);
    }
  }
  const complete = new Set();
  function visitPackage(name, stack = []) {
    if (stack.includes(name)) {
      report('dependency-cycle', byName.get(name).file, undefined, `Local dependency cycle: ${[...stack.slice(stack.indexOf(name)), name].join(' -> ')}`);
      return;
    }
    if (complete.has(name)) return;
    for (const dependency of graph.get(name) ?? []) visitPackage(dependency, [...stack, name]);
    complete.add(name);
  }
  for (const name of [...graph.keys()].sort()) visitPackage(name);

  const sources = [...new Set([
    ...packages.flatMap(pkg => walk(pkg.directory)),
    ...ROOT_AREAS.flatMap(area => walk(path.join(root, area))),
    ...readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && SOURCE.test(entry.name)).map(entry => path.join(root, entry.name)),
  ])].sort();
  // Symbol lookup lets constant folding respect lexical scope and shadowing.
  // noResolve keeps this syntax program out of generated/external modules.
  const program = ts.createProgram(sources, { allowJs: true, noResolve: true, noLib: true, types: [] });
  const checker = program.getTypeChecker();
  const configCache = new Map();
  function configFor(file) {
    let directory = path.dirname(file);
    while (inside(directory, root)) {
      const candidate = path.join(directory, 'tsconfig.json');
      if (existsSync(candidate)) {
        if (!configCache.has(candidate)) {
          const result = ts.readConfigFile(candidate, ts.sys.readFile);
          if (result.error) throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, '\n'));
          configCache.set(candidate, ts.parseJsonConfigFileContent(result.config, ts.sys, directory));
        }
        return configCache.get(candidate);
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
    return { options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true }, fileNames: [] };
  }
  const localSpecifier = specifier => [...byName.keys()].sort((a, b) => b.length - a.length).find(name => specifier === name || specifier.startsWith(`${name}/`));

  for (const file of sources) {
    const source = program.getSourceFile(file);
    const consumer = owner(file);
    const config = configFor(file);
    const emittedFile = config.options.rootDir && config.options.outDir && config.fileNames.includes(file) && !config.options.noEmit
      ? path.join(config.options.outDir, path.relative(config.options.rootDir, file)).replace(/\.[cm]?tsx?$/, '.js') : file;
    const builtinNames = new Map();
    const builtinObjects = new Map();
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text.replace(/^node:/, '');
      if (!['path', 'url', 'fs', 'fs/promises', 'module'].includes(module)) continue;
      if (statement.importClause?.name) builtinObjects.set(statement.importClause.name.text, module);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) builtinObjects.set(bindings.name.text, module);
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) builtinNames.set(binding.name.text, { module, name: binding.propertyName?.text ?? binding.name.text });
    }
    const builtin = expression => {
      if (ts.isIdentifier(expression)) return builtinNames.get(expression.text);
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
        const module = builtinObjects.get(expression.expression.text);
        if (module) return { module, name: expression.name.text };
      }
      return undefined;
    };
    const dependencies = new Set(DEPENDENCIES.flatMap(section => Object.keys(consumer.manifest[section] ?? {})));
    const productionDependencies = new Set(PRODUCTION_DEPENDENCIES.flatMap(section => Object.keys(consumer.manifest[section] ?? {})));
    const production = productionSource(file, consumer, rootPackage);
    const requireExpression = expression => {
      if (ts.isCallExpression(expression)) {
        const api = builtin(expression.expression);
        return api?.module === 'module' && api.name === 'createRequire';
      }
      if (!ts.isIdentifier(expression)) return false;
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return requireExpression(declaration.initializer);
      return expression.text === 'require' && !declaration;
    };
    function moduleCall(node) {
      if (!ts.isCallExpression(node)) return undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || requireExpression(node.expression)) return 'import';
      if (node.expression.getText(source) === 'import.meta.resolve' ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' && requireExpression(node.expression.expression))) return 'locator';
      return undefined;
    }
    function checkSpecifier(specifier, node, { typeOnly = false, locator = false } = {}) {
      typeOnly ||= source.isDeclarationFile;
      const contextual = locator && contextualModuleLocators.some(entry => entry.consumer === path.relative(root, file).split(path.sep).join('/') && entry.specifier === specifier);
      const name = localSpecifier(specifier);
      const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#') && !specifier.includes(':');
      const packageName = name ?? (bare ? specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] : undefined);
      if (packageName && !BUILTINS.has(specifier) && packageName !== consumer.manifest.name && !contextual) {
        if (!dependencies.has(packageName)) report('undeclared-dependency', file, node, `${consumer.manifest.name} consumes ${packageName} without declaring an owning dependency.`);
        else if (production && !typeOnly && !productionDependencies.has(packageName)) report('production-dev-dependency', file, node, `${consumer.manifest.name} production code consumes ${packageName}, declared only in devDependencies.`);
      }
      const resolved = ts.resolveModuleName(specifier, file, config.options, ts.sys, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule;
      if (name) {
        const producer = byName.get(name);
        const entry = exportMatch(producer.manifest, specifier === name ? '.' : `.${specifier.slice(name.length)}`);
        if (entry === undefined || entry === null) report('unexported-import', file, node, `${specifier} is not an exported package entry.`);
        else for (const target of targets(entry)) {
          if (!target.startsWith('./') || !inside(path.resolve(producer.directory, target), producer.directory) || !existsSync(path.resolve(producer.directory, target))) report('unresolved-export', file, node, `${specifier} resolves to missing/invalid target ${JSON.stringify(target)}.`);
        }
        if (entry && targets(entry).some(target => SOURCE.test(target)) && !resolved) report('package-resolution', file, node, `${specifier} has an export but cannot resolve through the installed package; install and build its producer.`);
        if (resolved && owner(path.resolve(resolved.resolvedFileName)) !== producer) report('package-resolution', file, node, `${specifier} resolves outside the named producer: ${resolved.resolvedFileName}`);
        if (resolved && inside(path.resolve(resolved.resolvedFileName), path.join(producer.directory, 'src'))) {
          const resolvedFile = path.resolve(resolved.resolvedFileName);
          const selfReference = consumer === producer && !matchesPathAlias(config, specifier) &&
            targets(entry).some(target => reverseMappedSources(producer, target, config).includes(resolvedFile));
          if (!selfReference) report('source-resolution', file, node, `${specifier} resolves to source rather than its exported build: ${resolved.resolvedFileName}`);
        }
        return;
      }
      if (specifier.startsWith('@canlang/')) report('unknown-local-package', file, node, `${specifier} names an unknown local package.`);
      if (resolved?.isExternalLibraryImport) return;
      const destination = resolved ? path.resolve(resolved.resolvedFileName) : specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : specifier.startsWith('file:') ? fileURLToPath(specifier) : path.isAbsolute(specifier) ? specifier : undefined;
      if (destination && (!inside(destination, consumer.directory) || owner(destination) !== consumer)) report('cross-package-import', file, node, `${specifier} bypasses the owning package API (${path.relative(root, destination)}).`);
    }
    function checkPath(value, node) {
      if (!value || value.kind !== 'path' || value.exported || !inside(value.value, root)) return;
      const producer = owner(value.value);
      if (producer === consumer) return;
      const target = path.relative(root, value.value).split(path.sep).join('/');
      const registration = checkoutInputs.find(entry => entry.consumer === path.relative(root, file).split(path.sep).join('/') && entry.target === target);
      if (registration) { registered.push(registration); return; }
      // Repository directory locators are context, not source/asset reads.
      if (producer === rootPackage && !path.extname(value.value)) return;
      report('cross-package-path', file, node, `${target} bypasses the owning package API; use an exported asset or distribution locator.`);
    }
    const plain = value => value?.kind === 'string' || value?.kind === 'path' ? value.value : undefined;
    function evaluate(node, environment = new Map(), active = new Set()) {
      if (!node || active.has(node)) return undefined;
      const next = new Set(active).add(node);
      const recur = child => evaluate(child, environment, next);
      if (ts.isStringLiteralLike(node)) return { kind: 'string', value: node.text };
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return recur(node.expression);
      if (node.getText(source) === 'import.meta.url') return { kind: 'path', value: emittedFile };
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (environment.has(symbol)) return environment.get(symbol);
        const declaration = symbol?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && (declaration.parent.flags & ts.NodeFlags.Const)) return recur(declaration.initializer);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = recur(node.left), right = recur(node.right);
        if (plain(left) !== undefined && plain(right) !== undefined) return { kind: 'string', value: plain(left) + plain(right) };
      }
      if (ts.isTemplateExpression(node)) {
        let value = node.head.text;
        for (const span of node.templateSpans) { const part = plain(recur(span.expression)); if (part === undefined) return undefined; value += part + span.literal.text; }
        return { kind: 'string', value };
      }
      if (ts.isArrayLiteralExpression(node)) { const values = node.elements.map(recur); if (values.every(Boolean)) return { kind: 'array', values }; }
      if (ts.isPropertyAccessExpression(node) && ['href', 'pathname'].includes(node.name.text)) return recur(node.expression);
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL') {
        const target = recur(node.arguments?.[0]), base = recur(node.arguments?.[1]);
        if (target?.kind === 'path' && !base) return target;
        if (target?.kind === 'string' && base?.kind === 'path') {
          const url = new URL(target.value, pathToFileURL(base.value));
          if (url.protocol === 'file:') return { kind: 'path', value: fileURLToPath(url), exported: base.exported };
        }
      }
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        const args = node.arguments.map(recur);
        if (name === 'import.meta.resolve' && args[0]?.kind === 'string') {
          const packageName = localSpecifier(args[0].value), producer = byName.get(packageName);
          const target = producer && runtimeTarget(exportMatch(producer.manifest, args[0].value === packageName ? '.' : `.${args[0].value.slice(packageName.length)}`));
          if (target) return { kind: 'path', value: path.resolve(producer.directory, target), exported: true };
        }
        const api = builtin(node.expression);
        if (api?.module === 'url' && api.name === 'fileURLToPath' && args[0]?.kind === 'path') return args[0];
        if (api?.module === 'path' && api.name === 'dirname' && args[0]?.kind === 'path') return { ...args[0], value: path.dirname(args[0].value) };
        if (api?.module === 'path' && ['join', 'resolve'].includes(api.name) && args.length && args.every(arg => plain(arg) !== undefined)) return { kind: 'path', value: path.resolve(...args.map(plain)), exported: args.some(arg => arg.exported) };
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
          const array = recur(node.expression.expression);
          if (array?.kind === 'array' && array.values.every(value => plain(value) !== undefined) && args[0]?.kind === 'string') return { kind: 'string', value: array.values.map(plain).join(args[0].value) };
        }
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'replace' && args[1]?.kind === 'string') {
          const input = recur(node.expression.expression);
          if (input?.kind === 'string' && args[0]?.kind === 'string') return { kind: 'string', value: input.value.replace(args[0].value, args[1].value) };
          const pattern = node.arguments[0];
          // Fold simple anchored suffix/prefix edits; leave general regexes
          // to runtime review rather than evaluating arbitrary source code.
          if (input?.kind === 'string' && pattern?.kind === ts.SyntaxKind.RegularExpressionLiteral) {
            const match = pattern.getText(source).match(/^\/(.+)\/([gimy]*)$/);
            if (match && !/[\[\](){}*+?|]/.test(match[1])) return { kind: 'string', value: input.value.replace(new RegExp(match[1], match[2]), args[1].value) };
          }
        }
        if (ts.isIdentifier(node.expression)) {
          const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
          if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body?.statements.length === 1 && ts.isReturnStatement(declaration.body.statements[0]) && args.every(Boolean)) {
            const bindings = new Map(environment);
            declaration.parameters.forEach((parameter, index) => bindings.set(checker.getSymbolAtLocation(parameter.name), args[index]));
            return evaluate(declaration.body.statements[0].expression, bindings, next);
          }
        }
      }
      return undefined;
    }
    function audit(kind, node) { unresolved.push({ kind, file: path.relative(root, file).split(path.sep).join('/'), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression: node.getText(source).slice(0, 180) }); }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) checkSpecifier(node.moduleSpecifier.text, node.moduleSpecifier, { typeOnly: typeOnlyModule(node) });
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) checkSpecifier(node.argument.literal.text, node.argument.literal, { typeOnly: true });
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) checkSpecifier(node.moduleReference.expression.text, node.moduleReference.expression, { typeOnly: node.isTypeOnly });
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        const kind = moduleCall(node);
        if (kind) {
          const value = evaluate(node.arguments[0]);
          if (plain(value) !== undefined) checkSpecifier(plain(value), node.arguments[0], { locator: kind === 'locator' });
          else audit('module', node);
        }
        // A local loader may take a specifier parameter to preserve lazy
        // startup. Check statically known call arguments at their callsites;
        // do not turn its remaining runtime callers into blanket exemptions.
        if (ts.isIdentifier(node.expression)) {
          const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
          if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body) {
            const bindings = new Map();
            declaration.parameters.forEach((parameter, index) => bindings.set(checker.getSymbolAtLocation(parameter.name), evaluate(node.arguments[index])));
            const inspect = child => {
              const childKind = moduleCall(child);
              if (childKind) {
                const specifier = plain(evaluate(child.arguments[0], bindings));
                if (specifier !== undefined) checkSpecifier(specifier, node, { locator: childKind === 'locator' });
              }
              ts.forEachChild(child, inspect);
            };
            inspect(declaration.body);
          }
        }
        const api = builtin(node.expression);
        if (api && ['fs', 'fs/promises'].includes(api.module) && /^(?:readFile|readdir|stat|lstat|access|exists|open|copyFile|writeFile|mkdir|rm|unlink)(?:Sync)?$/.test(api.name)) {
          const value = evaluate(node.arguments[0]);
          if (value?.kind === 'path') checkPath(value, node.arguments[0]);
          else audit('filesystem', node);
        }
      }
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL' && node.arguments?.[1]) {
        const value = evaluate(node);
        if (value?.kind === 'path') checkPath(value, node);
        else if (node.arguments[1].getText(source).includes('import.meta')) audit('url', node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  errors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code));
  return { packages: packages.length, files: sources.length, errors, unresolved, checkoutInputs, registered };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some(arg => !['--audit', '--json', '--dependencies-only'].includes(arg))) throw new Error('Usage: node scripts/check-package-boundaries.mjs [--audit] [--json] [--dependencies-only]');
    const dependenciesOnly = arguments_.includes('--dependencies-only');
    const result = checkPackageBoundaries(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), { dependenciesOnly });
    if (arguments_.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      for (const error of result.errors) console.error(`${error.file}:${error.line} [${error.code}] ${error.message}`);
      if (arguments_.includes('--audit')) for (const item of result.unresolved) console.log(`${item.file}:${item.line} [review:${item.kind}] ${item.expression}`);
      console.log(`Package ${dependenciesOnly ? 'dependencies' : 'boundaries'}: ${result.packages} packages, ${result.files} JS/TS files, ${result.errors.length} violations, ${result.unresolved.length} runtime/context expressions (--audit).`);
    }
    process.exitCode = result.errors.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
