/** Shared runtime/build validation. No bundler or development runtime imports. */
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {parse as parseJavaScript} from 'acorn';
import {analyze as analyzeScopes} from 'eslint-scope';
import {walk as walkJavaScript} from 'estree-walker';
import type {AssetInventory,DeploymentAsset} from '@canlang/contracts';
import {GROUP_ORDER,isRelativeImportSpecifier as isRelativeSpecifier,scanModuleImports,type ModuleImport} from './module-imports.js';

export interface ModuleImportFact {
  readonly groupRank: number;
  readonly statementStart: number;
  readonly statementEnd: number;
  readonly argumentStart: number;
  readonly argumentEnd: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  /** Raw literal slice (028: escapes keep raw distinct from decoded). */
  readonly raw: string | null;
  /** Owner-decoded specifier (028: trusted at the decoder boundary). */
  readonly specifier: string | null;
}
export interface ModuleUnresolvedFact {
  readonly group: 0 | 1 | 2;
  /** Original UTF-16 start (028: escaped idents keep owner coordinates). */
  readonly start: number;
  /** Original UTF-16 end. */
  readonly end: number;
  /** Acorn-decoded identifier name (028: binds escaped spellings). */
  readonly name: string;
}
export interface ModuleSyntaxFacts {
  readonly imports: readonly ModuleImportFact[];
  /** Import-lexer refusal offset (owner import-syntax error). */
  readonly lexerError: number | null;
  /** Non-offset import-frontend refusal: exact owner message, opaque. */
  readonly frontendError: string | null;
  /** Acorn refusal offset (owner JS-syntax error). */
  readonly syntaxError: number | null;
  /** `file://` import statement starts, in import-record order. */
  readonly fileUrl: readonly number[];
  /** Unresolved gates: 0 bare require(, 1 module.exports, 2 free exports. */
  readonly unresolved: readonly ModuleUnresolvedFact[];
}
const EMPTY_FACTS: ModuleSyntaxFacts = {
  imports: [],
  lexerError: null,
  frontendError: null,
  syntaxError: null,
  fileUrl: [],
  unresolved: [],
};
export function scanModuleFacts(source: string, modulePath: string): ModuleSyntaxFacts {
  let records: readonly ModuleImport[];
  try {
    records = scanModuleImports(source, modulePath);
  } catch (error) {
    // Offset-carrying throws (wrapped import-syntax included) ride
    // as structured lexer facts so eager all-module collection keeps
    // per-module first-error order; anything else rides the exact
    // owner message opaquely at the same precedence. Never parsed.
    const offset = (error as { idx?: unknown } | null)?.idx;
    if (typeof offset === "number" && Number.isInteger(offset)) {
      return { ...EMPTY_FACTS, lexerError: offset };
    }
    return {
      ...EMPTY_FACTS,
      frontendError: error instanceof Error ? error.message : String(error),
    };
  }
  const fileUrl: number[] = [];
  for (const record of records) {
    if (record.specifier?.startsWith("file://")) fileUrl.push(record.statement.start);
  }
  let ast: Parameters<typeof walkJavaScript>[0];
  try {
    // Acorn's ESTree nodes retain original UTF-16 ranges for scope diagnostics.
    ast = parseJavaScript(source, { ecmaVersion: 2025, sourceType: "module", ranges: true }) as unknown as Parameters<typeof walkJavaScript>[0];
  } catch (error) {
    const offset = (error as { pos?: unknown } | null)?.pos;
    if (typeof offset !== "number" || !Number.isInteger(offset)) throw error;
    return {
      imports: records.map(toImportFact),
      lexerError: null,
      frontendError: null,
      syntaxError: offset,
      fileUrl,
      unresolved: [],
    };
  }
  // Resolve lexical module bindings. Dynamic eval contents are outside this
  // preflight; no implicit Node/CommonJS bindings or wrapper exemptions apply.
  const scope = analyzeScopes(ast, { ecmaVersion: 2025, sourceType: "module", ignoreEval: true, nodejsScope: false });
  const unresolved = new Set(scope.globalScope!.through.map((reference) => reference.identifier));
  const offsets: [ModuleUnresolvedFact[], ModuleUnresolvedFact[], ModuleUnresolvedFact[]] = [[], [], []];
  walkJavaScript(ast, {
    enter(node, parent) {
      if (node.type !== "Identifier" || !unresolved.has(node)) return;
      const [start, end] = node.range!;
      const directCall = parent?.type === "NewExpression" || (parent?.type === "CallExpression" && !parent.optional);
      if (node.name === "require" && directCall && parent.callee === node) {
        offsets[0].push({ group: 0, start, end, name: node.name });
      }
      if (node.name === "module" && parent?.type === "MemberExpression" && parent.object === node && !parent.computed && !parent.optional && parent.property.type === "Identifier" && parent.property.name === "exports") {
        offsets[1].push({ group: 1, start, end, name: node.name });
      }
      if (node.name === "exports") offsets[2].push({ group: 2, start, end, name: node.name });
    },
  });
  const flat: ModuleUnresolvedFact[] = [];
  for (const positions of offsets) {
    for (const item of positions.sort((a, b) => a.start - b.start)) flat.push(item);
  }
  return {
    imports: records.map(toImportFact),
    lexerError: null,
    frontendError: null,
    syntaxError: null,
    fileUrl,
    unresolved: flat,
  };
}
function toImportFact(record: ModuleImport): ModuleImportFact {
  return {
    groupRank: GROUP_ORDER[record.group],
    statementStart: record.statement.start,
    statementEnd: record.statement.end,
    argumentStart: record.argument.start,
    argumentEnd: record.argument.end,
    contentStart: record.content?.start ?? -1,
    contentEnd: record.content?.end ?? -1,
    raw: record.rawSpecifier ?? null,
    specifier: record.specifier ?? null,
  };
}
/**
 * Refuse frontend facts at the original import-scan precedence (037): a
 * non-offset import-frontend refusal rides the exact owner message (the
 * old direct `scanModuleImports` path threw it); offset/syntax refusals
 * keep their messages; free-reference issues follow. Pure over facts so
 * the precedence contract is directly checkable.
 */
export function refuseModuleFrontendIssues(facts: ModuleSyntaxFacts, modulePath: string): string[] {
  if (facts.frontendError !== null) {
    throw new Error(facts.frontendError);
  }
  if (facts.lexerError !== null) {
    throw new Error(`deploy bundle: module ${JSON.stringify(modulePath)} has invalid import syntax at offset ${facts.lexerError}`);
  }
  if (facts.syntaxError !== null) {
    throw new Error(`deploy bundle: module ${JSON.stringify(modulePath)} has invalid JavaScript syntax at offset ${facts.syntaxError}`);
  }
  const issues: string[] = [];
  for (const offset of facts.fileUrl) issues.push(`node file-URL import at offset ${offset}`);
  const labels = ["bare require( call", "CommonJS module.exports", "CommonJS free exports"] as const;
  for (const group of [0, 1, 2] as const) {
    for (const item of facts.unresolved) {
      if (item.group === group) issues.push(`${labels[group]} at offset ${item.start}`);
    }
  }
  return issues;
}

function scanModuleIssues(source: string, modulePath: string): string[] {
  return refuseModuleFrontendIssues(scanModuleFacts(source, modulePath), modulePath);
}

/**
 * Refuse any module that workerd cannot load as ESM: node file-URL imports
 * or free CommonJS references. Bound bundler `__commonJS` interop, quoted
 * tokens, and the stdlib `require` guard pass (proven by tests).
 */
export function assertWorkerdLoadable(modules: Readonly<Record<string, string>>): void {
  for (const [name, contents] of Object.entries(modules)) {
    const issues = scanModuleIssues(contents, name);
    if (issues.length > 0) {
      const extra = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
      throw new Error(
        `deploy bundle: module ${JSON.stringify(name)} is not workerd-loadable: ` +
          `${issues[0]}${extra}`,
      );
    }
  }
}

/**
 * Refuse dangling imports: every relative specifier in every staged module
 * must resolve to a staged key, and no bare specifier may survive (workerd
 * has no package resolution). Same blanking honesty as the loadability
 * scan. This is the check that fails the build when a staged module
 * imports a checkout-only path (the P-C/P-B skew class: real files,
 * unresolvable-in-worker specifiers).
 */
function collectLinkSpecifiers(js: string, modulePath: string): string[] {
  return scanModuleImports(js, modulePath).flatMap((record) => record.specifier === undefined ? [] : [record.specifier]);
}

export function assertLinksResolve(
  modules: Readonly<Record<string, string>>,
  binaryKeys: readonly string[] = [],
): void {
  const keys = new Set([...Object.keys(modules), ...binaryKeys]);
  for (const [name, contents] of Object.entries(modules)) {
    for (const spec of collectLinkSpecifiers(contents, name)) {
      if (!isRelativeSpecifier(spec)) {
        throw new Error(
          `deploy bundle: module ${JSON.stringify(name)} has bare import ` +
            `${JSON.stringify(spec)} (no package resolution in workerd)`,
        );
      }
      const target = posix.normalize(posix.join(posix.dirname(name), spec));
      if (!keys.has(target)) {
        throw new Error(
          `deploy bundle: module ${JSON.stringify(name)} imports ${JSON.stringify(spec)} ` +
            `(resolves to ${JSON.stringify(target)}): no such staged module`,
        );
      }
    }
  }
}


export function bundleSha256(mainModule: string, modules: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(modules).sort()) {
    sorted[key] = modules[key] as string;
  }
  return createHash("sha256").update(JSON.stringify({ mainModule, modules: sorted })).digest("hex");
}


export function inventorizeAssets(
  modules: Record<string, string>,
  binaries: Record<string, Uint8Array> = {},
): AssetInventory {
  // Null-prototype map: the collision check below must be exact (inherited
  // names such as "toString" are legitimate keys, not collisions), and no
  // entry may vanish through the inherited `__proto__` setter.
  const inventory: Record<string, DeploymentAsset> = Object.create(null);
  for (const [key, text] of Object.entries(modules)) {
    if (key === "") {
      throw new Error("deploy bundle: text module key must not be empty");
    }
    if (key === "__proto__") {
      throw new Error('deploy bundle: text module key must not be "__proto__"');
    }
    inventory[key] = { kind: "text", text };
  }
  for (const [key, bytes] of Object.entries(binaries)) {
    if (key === "") {
      throw new Error("deploy bundle: binary module key must not be empty");
    }
    if (key === "__proto__") {
      throw new Error('deploy bundle: binary module key must not be "__proto__"');
    }
    if (inventory[key] !== undefined) {
      throw new Error(`deploy bundle: binary key ${JSON.stringify(key)} collides with a text module`);
    }
    inventory[key] = { kind: "binary", bytes };
  }
  return inventory;
}


export function bundleMixedSha256(mainModule: string, inventory: AssetInventory): string {
  const hash = createHash("sha256");
  const encoder = new TextEncoder();
  const mainBytes = encoder.encode(mainModule);
  const mainLen = Buffer.alloc(4);
  mainLen.writeUInt32BE(mainBytes.length, 0);
  hash.update(mainLen);
  hash.update(mainBytes);
  for (const key of Object.keys(inventory).sort()) {
    const asset = inventory[key] as DeploymentAsset;
    const keyBytes = encoder.encode(key);
    const keyLen = Buffer.alloc(4);
    keyLen.writeUInt32BE(keyBytes.length, 0);
    hash.update(keyLen);
    hash.update(keyBytes);
    const raw = asset.kind === "binary" ? asset.bytes : encoder.encode(asset.text);
    hash.update(Buffer.from([asset.kind === "binary" ? 2 : 1]));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(raw.length), 0);
    hash.update(len);
    hash.update(raw);
  }
  return hash.digest("hex");
}

