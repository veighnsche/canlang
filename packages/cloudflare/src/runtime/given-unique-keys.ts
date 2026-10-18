/**
 * BGI-08 Given computed-key seam join (workerd-safe): resolve checked
 * `state.unique-key@1` bindings against assembled artifact modules and
 * build the pipeline rules the model table carries.
 *
 * Resolution is fingerprint-verified: the binding's SHA-256 must match
 * the saved implementation closure exactly, or the seam refuses with an
 * explicit changed-code outcome (re-validate and activate; never run
 * changed code silently, never regenerate). One import per saved unit/export
 * pair: a second compatible application reuses the resolved evaluator with
 * zero additional loading. The evaluator receives projected text only — no
 * record handles, no store, no registry, no commit.
 *
 * Implementation-closure fingerprint v1 (the cross-host contract the
 * compiler lane implements identically; coordinated by unit id plus
 * file bytes, never shared code):
 * - Member set: the staged root `can.generated/<unit>/server.js` plus
 *   every transitively imported unit-local relative module. Only
 *   relative specifiers (`.`, `..`, `./`, `../`) resolving inside
 *   `can.generated/<unit>/` are consumed; static, re-export, and
 *   literal-dynamic edges count, while non-literal, unresolvable,
 *   non-local, or CommonJS edges refuse instead of hashing a subset.
 * - No imports: SHA-256 over the exact root JS bytes, preserving the
 *   compiler-owned single-file identity.
 * - With imports: u64 big-endian root byte length, root UTF-8 bytes,
 *   then imports sorted by unit-relative UTF-8 path bytes. Each import
 *   contributes u64BE path length, relative path, u64BE JS length, JS.
 * - Staging changes implementation.js to server.js but does not enter
 *   that transport path or unit id into the checked code identity.
 * Specifiers resolve literally (POSIX, no query/fragment stripping,
 * no extension probing); every consumed byte remains verified.
 */

import { sha256HexBytes } from '@canlang/identity';
import type { CompileArtifact, ModelName, StateUniqueKeyProducerBinding, StateFieldValidationProducerBinding } from '@canlang/contracts';
import type { GivenUniqueKeyRule, GivenFieldValidationRule } from '@canlang/state/effects/staging';
import {
  AssemblyCorrespondenceError,
  importVerifiedAssemblyModule,
} from './assembly-verification.js';
import type { AssembledModules } from './modules.js';

/**
 * BGI-08 artifact module path for one saved Given unit. The BGI-11 packing
 * join writes saved `server.js` here; fingerprint verification keeps any
 * layout drift loud (unknown unit), never silent.
 */
export function givenUnitModulePath(unitId: string): string {
  return `can.generated/${unitId}/server.js`;
}

/**
 * BGI-08 resolve one checked binding to its saved evaluator: the unit
 * module must exist, its exact consumed import closure must match the
 * checked fingerprint, and the named export must be a function. Every
 * refusal names the rule and the failed join step; nothing falls back
 * to another module, export, or implementation.
 */
export async function resolveGivenKeywordExport(
  asm: AssembledModules,
  artifact: CompileArtifact,
  binding: Pick<StateUniqueKeyProducerBinding, 'rule' | 'implementation'>,
): Promise<GivenUniqueKeyRule['evaluate']> {
  const where = `Given rule ${JSON.stringify(binding.rule)}`;
  const { unit, export: exportName, fingerprint } = binding.implementation;
  const path = givenUnitModulePath(unit);
  const module = artifact.modules.find((candidate) => candidate.path === path);
  if (module === undefined) {
    throw new AssemblyCorrespondenceError(
      `${where} names unknown saved unit ${JSON.stringify(unit)}: expected module ${JSON.stringify(path)}.`,
    );
  }
  const members = resolveGivenClosure(artifact, unit);
  const actual = await givenClosureFingerprint(members);
  if (actual !== fingerprint) {
    throw new AssemblyCorrespondenceError(
      `${where} saved implementation changed (unit ${JSON.stringify(unit)} fingerprint mismatch): ` +
        're-validate and activate before use; refusing to run changed code silently.',
    );
  }
  const imported: unknown = await importVerifiedAssemblyModule(asm, path, artifact);
  if (typeof imported !== 'object' || imported === null || !Object.hasOwn(imported, exportName)) {
    throw new AssemblyCorrespondenceError(
      `${where} saved unit ${JSON.stringify(unit)} has no export ${JSON.stringify(exportName)}.`,
    );
  }
  const candidate = (imported as Record<string, unknown>)[exportName];
  if (typeof candidate !== 'function') {
    throw new AssemblyCorrespondenceError(
      `${where} saved export ${JSON.stringify(exportName)} is not a function.`,
    );
  }
  return candidate as GivenUniqueKeyRule['evaluate'];
}

/**
 * BGI-08 resolve every checked binding into per-model pipeline rules,
 * sharing one evaluator per saved unit/export/fingerprint triple. Empty
 * bindings resolve to an empty map (artifacts without keyword rules keep
 * their exact prior posture).
 */
export async function joinGivenUniqueKeys(
  asm: AssembledModules,
  artifact: CompileArtifact,
  bindings: ReadonlyArray<StateUniqueKeyProducerBinding>,
): Promise<ReadonlyMap<ModelName, ReadonlyArray<GivenUniqueKeyRule>>> {
  const byModel = new Map<ModelName, GivenUniqueKeyRule[]>();
  if (bindings.length === 0) return byModel;
  const resolved = new Map<string, GivenUniqueKeyRule['evaluate']>();
  for (const binding of bindings) {
    const identity = JSON.stringify([
      binding.implementation.unit,
      binding.implementation.export,
      binding.implementation.fingerprint,
    ]);
    let evaluate = resolved.get(identity);
    if (evaluate === undefined) {
      evaluate = await resolveGivenKeywordExport(asm, artifact, binding);
      resolved.set(identity, evaluate);
    }
    const rules = byModel.get(binding.model);
    const rule: GivenUniqueKeyRule = { rule: binding.rule, field: binding.field, evaluate };
    if (rules === undefined) byModel.set(binding.model, [rule]);
    else rules.push(rule);
  }
  return byModel;
}

/** Resolve pure field checks through the same verified saved-module boundary. */
export async function joinGivenFieldValidations(
  asm: AssembledModules,
  artifact: CompileArtifact,
  bindings: ReadonlyArray<StateFieldValidationProducerBinding>,
): Promise<ReadonlyMap<ModelName, ReadonlyArray<GivenFieldValidationRule>>> {
  const byModel = new Map<ModelName, GivenFieldValidationRule[]>();
  const resolved = new Map<string, GivenFieldValidationRule['evaluate']>();
  for (const binding of bindings) {
    const identity = JSON.stringify(binding.implementation);
    let evaluate = resolved.get(identity);
    if (evaluate === undefined) {
      evaluate = await resolveGivenKeywordExport(asm, artifact, binding) as unknown as GivenFieldValidationRule['evaluate'];
      resolved.set(identity, evaluate);
    }
    const rules = byModel.get(binding.model) ?? [];
    rules.push({ rule: binding.rule, field: binding.field, evaluate });
    byModel.set(binding.model, rules);
  }
  return byModel;
}

/** One closure member: staged path plus staged bytes. */
export interface GivenClosureMember {
  path: string;
  js: string;
}

/** Whether a specifier stays inside the unit's own directory. */
function isUnitRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

function posixNormalize(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (absolute) return `/${joined}`;
  return joined === '' ? '.' : joined;
}

function posixJoin(dir: string, spec: string): string {
  if (spec.startsWith('/')) return posixNormalize(spec);
  return posixNormalize(dir === '.' || dir === '' ? spec : `${dir}/${spec}`);
}

/**
 * Resolve the exact consumed unit-local import closure for one saved
 * Given unit: the staged root plus every transitively reachable
 * unit-local relative module. Non-literal, unresolvable, escaping,
 * missing, or CommonJS edges refuse fail-closed; nothing silently
 * narrows the hashed set.
 */
export function resolveGivenClosure(
  artifact: CompileArtifact,
  unit: string,
): GivenClosureMember[] {
  const prefix = `can.generated/${unit}/`;
  const unitDir = `can.generated/${unit}`;
  const rootPath = givenUnitModulePath(unit);
  const byPath = new Map<string, string>();
  for (const module of artifact.modules) byPath.set(module.path, module.js);
  const rootJs = byPath.get(rootPath);
  if (rootJs === undefined) {
    throw new AssemblyCorrespondenceError(
      `Computed-key closure for unit ${JSON.stringify(unit)} names an unknown saved unit: ` +
        `expected module ${JSON.stringify(rootPath)}.`,
    );
  }
  const members = new Map<string, string>([[rootPath, rootJs]]);
  const queue: string[] = [rootPath];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const js = members.get(current) as string;
    const scan = scanGivenJsModule(js);
    if (scan.hasRequire) {
      throw new AssemblyCorrespondenceError(
        `Computed-key closure for unit ${JSON.stringify(unit)} calls \`require(\` at offset ` +
          `${String(scan.requireOffset)} in ${JSON.stringify(current)}; CommonJS require never enters worker bundles.`,
      );
    }
    for (const edge of scan.imports) {
      if (edge.unresolved || edge.specifier === '') {
        throw new AssemblyCorrespondenceError(
          `Computed-key closure for unit ${JSON.stringify(unit)} has an unresolvable import at offset ` +
            `${String(edge.offset)} in ${JSON.stringify(current)}; refusing to hash a partial closure.`,
        );
      }
      if (!isUnitRelativeSpecifier(edge.specifier)) {
        throw new AssemblyCorrespondenceError(
          `Computed-key closure for unit ${JSON.stringify(unit)} imports non-local specifier ` +
            `${JSON.stringify(edge.specifier)} at offset ${String(edge.offset)} in ${JSON.stringify(current)}; ` +
            `only unit-local relative imports are consumed.`,
        );
      }
      const target = posixJoin(posixDirname(current), edge.specifier);
      if (target !== unitDir && !target.startsWith(prefix)) {
        throw new AssemblyCorrespondenceError(
          `Computed-key closure for unit ${JSON.stringify(unit)} imports ${JSON.stringify(edge.specifier)} ` +
            `at offset ${String(edge.offset)} in ${JSON.stringify(current)} (resolves to ${JSON.stringify(target)}); ` +
            `the closure never leaves the unit.`,
        );
      }
      if (members.has(target)) continue;
      const targetJs = byPath.get(target);
      if (targetJs === undefined) {
        throw new AssemblyCorrespondenceError(
          `Computed-key closure for unit ${JSON.stringify(unit)} imports ${JSON.stringify(edge.specifier)} ` +
            `at offset ${String(edge.offset)} in ${JSON.stringify(current)} (resolves to ${JSON.stringify(target)}): ` +
            `no such staged module.`,
        );
      }
      members.set(target, targetJs);
      queue.push(target);
    }
  }
  return [...members.entries()].map(([path, js]) => ({ path, js }));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** Canonical bytes matching the compiler's checked implementation identity. */
export function givenClosureBytes(members: readonly GivenClosureMember[]): Uint8Array {
  const encoder = new TextEncoder();
  const roots = members.filter(member => /^can\.generated\/[^/]+\/server\.js$/.test(member.path));
  if (roots.length !== 1) throw new AssemblyCorrespondenceError('Computed-key closure needs exactly one staged root.');
  const root = roots[0]!;
  const prefix = root.path.slice(0, -'server.js'.length);
  const seen = new Set<string>();
  for (const member of members) {
    const rel = member.path.slice(prefix.length);
    if (!member.path.startsWith(prefix) || rel === '' || rel.split('/').some(part => part === '' || part === '.' || part === '..') || seen.has(member.path)) {
      throw new AssemblyCorrespondenceError('Computed-key closure has duplicate or non-local members.');
    }
    seen.add(member.path);
  }
  const rootBytes = encoder.encode(root.js);
  if (members.length === 1) return rootBytes;
  const imports = members.filter(member => member !== root).map(member => ({
    path: encoder.encode(member.path.slice(prefix.length)), js: encoder.encode(member.js),
  }));
  imports.sort((a, b) => compareBytes(a.path, b.path));
  let total = 8 + rootBytes.length;
  for (const member of imports) total += 8 + member.path.length + 8 + member.js.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u64 = (n: number): void => {
    view.setUint32(at, Math.floor(n / 4294967296));
    view.setUint32(at + 4, n % 4294967296);
    at += 8;
  };
  u64(rootBytes.length);
  out.set(rootBytes, at);
  at += rootBytes.length;
  for (const member of imports) {
    u64(member.path.length);
    out.set(member.path, at);
    at += member.path.length;
    u64(member.js.length);
    out.set(member.js, at);
    at += member.js.length;
  }
  return out;
}

/** Fingerprint one resolved closure: lowercase hex SHA-256 over the canonical bytes. */
export async function givenClosureFingerprint(
  members: readonly GivenClosureMember[],
): Promise<string> {
  return sha256HexBytes(givenClosureBytes(members));
}

/** One lexical import edge of a saved module. */
export interface GivenJsImportEdge {
  /** Literal specifier text (raw; escapes stay unevaluated). */
  specifier: string;
  /** UTF-16 offset of the specifier (or keyword for unresolved edges). */
  offset: number;
  /** True for dynamic `import()` edges. */
  dynamic: boolean;
  /** True when no literal specifier could be resolved lexically (fail-closed). */
  unresolved: boolean;
}

/**
 * Lexical view of a saved module: import edges plus CommonJS
 * refusal evidence. Finite static admission, never execution or a
 * full parse: comments and string-literal contents are blanked
 * before keyword matching so quoted tokens cannot certify an edge.
 * Template `${...}` interpolations stay code, a conservative
 * over-approximation matching the compiler-side scan.
 */
export interface GivenJsModuleScan {
  imports: GivenJsImportEdge[];
  hasRequire: boolean;
  requireOffset: number;
}

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}

function isTrivia(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

function blankRange(chars: string[], from: number, to: number): void {
  for (let i = from; i < to; i += 1) {
    if (chars[i] !== '\n') chars[i] = ' ';
  }
}

function scanLineCommentEnd(chars: string[], i: number): number {
  while (i < chars.length && chars[i] !== '\n') i += 1;
  return i;
}

function scanBlockCommentEnd(chars: string[], i: number): number {
  i += 2;
  while (i + 1 < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) i += 1;
  return Math.min(i + 2, chars.length);
}

function scanQuotedEnd(chars: string[], i: number, quote: string): number {
  i += 1;
  while (i < chars.length) {
    if (chars[i] === '\\') i += 2;
    else if (chars[i] === '\n') break;
    else if (chars[i] === quote) {
      i += 1;
      break;
    } else i += 1;
  }
  return i;
}

function skipTemplateInterpolation(chars: string[], i: number): number {
  i += 2;
  let depth = 1;
  while (i < chars.length && depth > 0) {
    if (chars[i] === '{') depth += 1;
    else if (chars[i] === '}') depth -= 1;
    i += 1;
  }
  return i;
}

function scanTemplateEnd(chars: string[], i: number): number {
  chars[i] = ' ';
  i += 1;
  while (i < chars.length) {
    if (chars[i] === '$' && i + 1 < chars.length && chars[i + 1] === '{') {
      i = skipTemplateInterpolation(chars, i);
    } else if (chars[i] === '\\') {
      chars[i] = ' ';
      if (i + 1 < chars.length && chars[i + 1] !== '\n') chars[i + 1] = ' ';
      i += 2;
    } else if (chars[i] === '`') {
      chars[i] = ' ';
      i += 1;
      break;
    } else {
      if (chars[i] !== '\n') chars[i] = ' ';
      i += 1;
    }
  }
  return i;
}

/** Blank comments and string-literal contents, preserving length and newlines. */
function blankGivenJsTrivia(js: string): string[] {
  const chars = js.split('');
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] as string;
    const next = (i + 1 < chars.length ? chars[i + 1] : '') as string;
    const from = i;
    if (ch === '/' && next === '/') {
      i = scanLineCommentEnd(chars, i);
      blankRange(chars, from, i);
    } else if (ch === '/' && next === '*') {
      i = scanBlockCommentEnd(chars, i);
      blankRange(chars, from, i);
    } else if (ch === "'" || ch === '"') {
      i = scanQuotedEnd(chars, i, ch);
      blankRange(chars, from, i);
    } else if (ch === '`') {
      i = scanTemplateEnd(chars, i);
    } else {
      i += 1;
    }
  }
  return chars;
}

function keywordAt(blanked: string[], i: number, word: string): boolean {
  if (i + word.length > blanked.length) return false;
  for (let k = 0; k < word.length; k += 1) {
    if (blanked[i + k] !== word[k]) return false;
  }
  const before = i === 0 ? -1 : (blanked[i - 1] as string).charCodeAt(0);
  const after =
    i + word.length >= blanked.length ? -1 : (blanked[i + word.length] as string).charCodeAt(0);
  if (before !== -1 && isIdentPart(before)) return false;
  if (after !== -1 && isIdentPart(after)) return false;
  return true;
}

/** Skip whitespace and comments in the original text, where quotes are intact. */
function skipTriviaOriginal(js: string, cursor: { at: number }): void {
  for (;;) {
    while (cursor.at < js.length && isTrivia(js.charCodeAt(cursor.at))) cursor.at += 1;
    const slash = js[cursor.at];
    const second = js[cursor.at + 1];
    if (slash === '/' && second === '/') {
      while (cursor.at < js.length && js[cursor.at] !== '\n') cursor.at += 1;
    } else if (slash === '/' && second === '*') {
      cursor.at += 2;
      while (
        cursor.at + 1 < js.length &&
        !(js[cursor.at] === '*' && js[cursor.at + 1] === '/')
      ) {
        cursor.at += 1;
      }
      cursor.at = Math.min(cursor.at + 2, js.length);
    } else {
      break;
    }
  }
}

/**
 * Read one single/double-quoted specifier from the original text.
 * Template literals never count (a dynamic template edge is
 * unresolvable); escapes stay raw and compare literally.
 */
function readSpecifier(js: string, quoteAt: number): { spec: string; end: number } | null {
  const quote = js[quoteAt];
  if (quote !== "'" && quote !== '"') return null;
  let i = quoteAt + 1;
  while (i < js.length) {
    const ch = js[i] as string;
    if (ch === '\\') i += 2;
    else if (ch === '\n') return null;
    else if (ch === quote) return { spec: js.slice(quoteAt + 1, i), end: i + 1 };
    else i += 1;
  }
  return null;
}

function skipBlankedWs(blanked: string[], cursor: { at: number }): void {
  while (cursor.at < blanked.length && isTrivia((blanked[cursor.at] as string).charCodeAt(0))) {
    cursor.at += 1;
  }
}

/** Static import scan window (bounds pathological statements). */
const GIVEN_IMPORT_WINDOW = 4096;

/**
 * Lexically scan one saved module for import specifiers: static
 * `from` and bare specifiers, re-export `from`, and literal
 * dynamic `import()`. Anything else at an import keyword —
 * `import.meta` aside — records an unresolvable edge, and
 * `require(` records CommonJS evidence; both refuse downstream.
 */
export function scanGivenJsModule(js: string): GivenJsModuleScan {
  const blanked = blankGivenJsTrivia(js);
  const imports: GivenJsImportEdge[] = [];
  let hasRequire = false;
  let requireOffset = 0;
  let i = 0;
  while (i < blanked.length) {
    if (keywordAt(blanked, i, 'import')) {
      const cursor = { at: i + 6 };
      skipTriviaOriginal(js, cursor);
      const j = cursor.at;
      if (js[j] === '(') {
        const inner = { at: j + 1 };
        skipTriviaOriginal(js, inner);
        const spec = readSpecifier(js, inner.at);
        if (spec !== null) {
          imports.push({ specifier: spec.spec, offset: inner.at, dynamic: true, unresolved: false });
          i = spec.end;
        } else {
          imports.push({ specifier: '', offset: i, dynamic: true, unresolved: true });
          i = inner.at;
        }
        continue;
      }
      if (
        j + 4 <= blanked.length &&
        blanked[j] === '.' &&
        keywordAt(blanked, j + 1, 'meta')
      ) {
        i = j + 5;
        continue;
      }
      let k = j;
      let found: { spec: string; at: number; end: number } | null = null;
      const window = Math.min(j + GIVEN_IMPORT_WINDOW, blanked.length);
      while (k < window && blanked[k] !== ';') {
        if (keywordAt(blanked, k, 'from')) {
          const inner = { at: k + 4 };
          skipTriviaOriginal(js, inner);
          const spec = readSpecifier(js, inner.at);
          if (spec !== null) found = { spec: spec.spec, at: inner.at, end: spec.end };
          break;
        }
        const original = js[k];
        if (original === "'" || original === '"') {
          const spec = readSpecifier(js, k);
          if (spec !== null) found = { spec: spec.spec, at: k, end: spec.end };
          break;
        }
        k += 1;
      }
      if (found !== null) {
        imports.push({ specifier: found.spec, offset: found.at, dynamic: false, unresolved: false });
        i = found.end;
      } else {
        imports.push({ specifier: '', offset: i, dynamic: false, unresolved: true });
        i = Math.min(k, blanked.length);
      }
      continue;
    }
    if (keywordAt(blanked, i, 'require')) {
      const cursor = { at: i + 7 };
      skipBlankedWs(blanked, cursor);
      if (blanked[cursor.at] === '(') {
        hasRequire = true;
        requireOffset = i;
      }
      i = cursor.at;
      continue;
    }
    if (keywordAt(blanked, i, 'from')) {
      const cursor = { at: i + 4 };
      skipTriviaOriginal(js, cursor);
      const spec = readSpecifier(js, cursor.at);
      if (spec !== null) {
        imports.push({ specifier: spec.spec, offset: cursor.at, dynamic: false, unresolved: false });
        i = spec.end;
        continue;
      }
    }
    i += 1;
  }
  return { imports, hasRequire, requireOffset };
}
