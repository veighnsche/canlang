/**
 * B1 op-execution path: invoke one callable from an assembled artifact.
 *
 * Coordinator decision R1 (recorded): invoke calls emitted handlers
 * DIRECTLY (their inlined by/guard admission runs for real); parity with
 * a canonical-invoke() entrypoint is a follow-up, not done here.
 *
 * T16b (the section below, additive): the follow-up lands for GENERATED
 * operations — artifacts carrying T15a descriptors route through the
 * canonical state path (`invokeMutationCanonical`), while the direct
 * entries above keep serving descriptor-less artifacts byte-identically
 * (existing suites pin them; T17 retires the interim path).
 *
 * T17b (this file): the cloudflare-side flip. Scenario handlers run with
 * a canonical effects scope (`runScenarioSeam` installs it): stdlib
 * writes stage through the canonical mutation pipeline into the
 * scenario effects (one atomic fenced commit with the scenario receipt),
 * and `records()` serves through `invokeRead` over the staged overlay.
 * Assembly reads flip onto `invokeReadCanonical` (refusal stub retired);
 * descriptor-less artifacts refuse at the router (interim direct path
 * retired — the direct entries above stay as the scenario seam's
 * handler-execution mechanism, not as a serving path).
 *
 * `ctx` is the real `./context.js` shape, passed through untouched as
 * the first handler argument; this module never inspects it.
 */
import type {
  CompileArtifact,
  InvocationContext,
  Membership,
  MutationResult,
  OccurrenceId,
  ProjectedRecord,
  ResolvedIdentity,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import type {
  CanonicalEffectsScope,
  CanonicalReadQuery,
  CanonicalStagedWrite,
  HandlerContext,
} from "./context.js";
import { createContext } from "./context.js";
import type { AssembledModules } from "./modules.js";
import type { MappedPosition } from "./sourcemap.js";
import { lookup } from "./sourcemap.js";

export type { AssembledModules } from "./modules.js";
export type { HandlerContext } from "./context.js";
export type { MappedPosition } from "./sourcemap.js";

export interface InvokeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /**
   * B3 I2: 1-based `.can` position the throwing frame maps to, attached
   * only when the top assembled frame resolves through the artifact map.
   * Absent on success, on resolution failures, and whenever the frame is
   * unmapped — existing message-only assertions are unaffected.
   */
  mapped?: MappedPosition;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One parsed stack frame pointing into an assembled module. */
export interface AssembledFrame {
  /** Artifact module path (key into `moduleUrls`). */
  module: string;
  /** 1-based generated line. */
  line: number;
  /** 1-based generated column (V8 convention). */
  column: number;
}

const PAREN_FRAME_RE = /^\s*at (?:async )?[^()]*\((.*):(\d+):(\d+)\)\s*$/;
const BARE_FRAME_RE = /^\s*at (?:async )?(.*):(\d+):(\d+)\s*$/;

/** `file://` URL to decoded path, or `null` for non-file URLs. */
function urlToPath(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  const path = url.slice("file://".length);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

interface ParsedFrame {
  file: string;
  line: number;
  column: number;
}

/** Top-down `file:line:col` frames; greedy from the line end so URLs with parens/colons parse. */
function parseStackFrames(stack: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = PAREN_FRAME_RE.exec(line) ?? BARE_FRAME_RE.exec(line);
    if (match === null) continue;
    const [, file, lineText, colText] = match;
    if (file === undefined || lineText === undefined || colText === undefined) continue;
    const parsedLine = Number.parseInt(lineText, 10);
    const parsedCol = Number.parseInt(colText, 10);
    if (!Number.isInteger(parsedLine) || parsedLine < 1) continue;
    if (!Number.isInteger(parsedCol) || parsedCol < 1) continue;
    frames.push({ file, line: parsedLine, column: parsedCol });
  }
  return frames;
}

/** Per-frame generated-module matcher: exact URL/path first, then longest `/<module>` suffix. */
function matchGeneratedModule(
  file: string,
  exact: ReadonlyMap<string, string>,
  suffixes: readonly { module: string; suffix: string }[],
): string | null {
  const direct = exact.get(file);
  if (direct !== undefined) return direct;
  const normalized = file.replace(/\\/g, "/");
  for (const { module, suffix } of suffixes) {
    if (normalized === module || normalized.endsWith(suffix)) return module;
  }
  return null;
}

function buildModuleMatchers(moduleUrls: Readonly<Record<string, string>>): {
  exact: Map<string, string>;
  suffixes: { module: string; suffix: string }[];
} {
  const exact = new Map<string, string>();
  const suffixes: { module: string; suffix: string }[] = [];
  for (const [module, url] of Object.entries(moduleUrls)) {
    exact.set(url, module);
    const path = urlToPath(url);
    if (path !== null) exact.set(path, module);
    suffixes.push({ module, suffix: `/${module}` });
  }
  suffixes.sort((a, b) => b.suffix.length - a.suffix.length);
  return { exact, suffixes };
}

/**
 * B3 I2: return the topmost stack frame pointing into an assembled module,
 * or `null` when no frame resolves. Each frame matches by exact module URL
 * (or its decoded `file://` path — V8 prints either form) or, failing
 * that, by longest `/<module path>` suffix, which covers realpath/symlink
 * divergence between the staged URL and the printed frame (e.g. macOS
 * `/tmp` vs `/private/tmp`). Pure and total: never throws.
 */
export function findAssembledFrame(
  stack: string,
  moduleUrls: Readonly<Record<string, string>>,
): AssembledFrame | null {
  const { exact, suffixes } = buildModuleMatchers(moduleUrls);
  for (const frame of parseStackFrames(stack)) {
    const module = matchGeneratedModule(frame.file, exact, suffixes);
    if (module !== null) return { module, line: frame.line, column: frame.column };
  }
  return null;
}

/**
 * B3 I2: return the already-mapped position from the topmost frame the
 * runtime remapped through a staged map (Node with source-map support
 * rewrites the frame file to the map's `sources` entry), or `null` when no
 * frame points into a known source. The frame's 1-based line/column are the
 * `.can` position directly. Pure and total: never throws.
 */
export function findRemappedFrame(
  stack: string,
  sources: readonly string[],
): MappedPosition | null {
  const ordered = sources.filter((source) => source.length > 0).sort((a, b) => b.length - a.length);
  for (const frame of parseStackFrames(stack)) {
    const normalized = frame.file.replace(/\\/g, "/");
    for (const source of ordered) {
      if (normalized === source || normalized.endsWith(`/${source}`)) {
        return { source, line: frame.line, column: frame.column };
      }
    }
  }
  return null;
}

/** Every map `sources` entry across artifact modules (flat; positions are source-global). */
function collectSources(artifact: CompileArtifact): string[] {
  const out: string[] = [];
  for (const mod of artifact.modules) {
    const sources: unknown = mod.map?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (typeof source === "string" && source.length > 0) out.push(source);
    }
  }
  return out;
}

/**
 * B3 I2: map a handler throw to its `.can` position, or `undefined` when
 * anything is missing (no stack, no assembled frame, unknown module,
 * unmapped position, malformed map). Single top-down scan: the first frame
 * classifying as a generated module frame resolves through that module's
 * map via `lookup` (V8 columns are 1-based; `lookup` takes 0-based); the
 * first frame classifying as a runtime-remapped source frame carries the
 * 1-based `.can` position directly. Never throws: mapping is diagnostic
 * only and must not break invoke's never-throws contract.
 */
function mapThrownError(
  error: unknown,
  artifact: CompileArtifact,
  asm: AssembledModules,
): MappedPosition | undefined {
  try {
    if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
    const { exact, suffixes } = buildModuleMatchers(asm.moduleUrls);
    const sources = collectSources(artifact).sort((a, b) => b.length - a.length);
    for (const frame of parseStackFrames(error.stack)) {
      const module = matchGeneratedModule(frame.file, exact, suffixes);
      if (module !== null) {
        const mod = artifact.modules.find((entry) => entry.path === module);
        if (mod === undefined) return undefined;
        // V8 columns are 1-based; `lookup` takes a 0-based generated column.
        return lookup(mod.map, frame.line, frame.column - 1) ?? undefined;
      }
      const normalized = frame.file.replace(/\\/g, "/");
      for (const source of sources) {
        if (normalized === source || normalized.endsWith(`/${source}`)) {
          return { source, line: frame.line, column: frame.column };
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Shared registry resolution + `fn(ctx, ...args)` call behind both public entries. */
async function invokeWith(
  asm: AssembledModules,
  artifact: CompileArtifact,
  id: string,
  ctx: HandlerContext,
  args?: unknown[],
): Promise<InvokeResult> {
  const callable = artifact.callables.find((entry) => entry.id === id);
  if (callable === undefined) {
    const available = artifact.callables.map((entry) => entry.id);
    return {
      ok: false,
      error:
        `unknown callable ${JSON.stringify(id)} ` +
        `(available: ${available.length > 0 ? available.join(", ") : "none"})`,
    };
  }
  const moduleUrl = asm.moduleUrls[callable.module];
  if (moduleUrl === undefined) {
    return {
      ok: false,
      error:
        `no assembled module URL for callable ${JSON.stringify(id)} ` +
        `module ${JSON.stringify(callable.module)}`,
    };
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(moduleUrl)) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      error:
        `cannot import module ${JSON.stringify(callable.module)} ` +
        `for callable ${JSON.stringify(id)}: ${message(error)}`,
    };
  }
  const member: unknown = callable.member;
  if (
    !Array.isArray(member) ||
    member.length === 0 ||
    !member.every((segment) => typeof segment === "string" && segment.length > 0)
  ) {
    return {
      ok: false,
      error:
        `callable ${JSON.stringify(id)} has no valid registry member path ` +
        `(member must be a non-empty array of non-empty strings); ` +
        "recompile with the fixed `can compile`",
    };
  }
  const segments = member as string[];
  const path = JSON.stringify(segments);
  const canApp: unknown = mod["canApp"];
  if (typeof canApp !== "function") {
    return {
      ok: false,
      error:
        `module ${JSON.stringify(callable.module)} has no canApp() registry ` +
        `for callable ${JSON.stringify(id)} (member path ${path})`,
    };
  }
  let current: unknown;
  try {
    current = (canApp as () => unknown)();
  } catch (error) {
    return {
      ok: false,
      error:
        `module ${JSON.stringify(callable.module)} canApp() threw ` +
        `for callable ${JSON.stringify(id)} (member path ${path}): ${message(error)}`,
    };
  }
  for (const [index, segment] of segments.entries()) {
    if (typeof current !== "object" || current === null) {
      const parent = index === 0 ? "canApp() registry" : `segment ${index - 1} value`;
      const actual = current === null ? "null" : typeof current;
      return {
        ok: false,
        error:
          `callable ${JSON.stringify(id)} member path ${path}: ` +
          `cannot resolve segment ${index} ${JSON.stringify(segment)} ` +
          `(${parent} is ${actual}, not an object)`,
      };
    }
    const next: unknown = (current as Record<string, unknown>)[segment];
    if (next === undefined) {
      return {
        ok: false,
        error:
          `callable ${JSON.stringify(id)} member path ${path}: ` +
          `missing segment ${index} ${JSON.stringify(segment)}`,
      };
    }
    const last = index === segments.length - 1;
    if (last && typeof next !== "function") {
      const actual = next === null ? "null" : typeof next;
      return {
        ok: false,
        error:
          `callable ${JSON.stringify(id)} member path ${path}: ` +
          `segment ${index} ${JSON.stringify(segment)} is ${actual}, not a function`,
      };
    }
    current = next;
  }
  const fn = current as (ctx: HandlerContext, ...args: unknown[]) => unknown;
  try {
    const value = await fn(ctx, ...(args ?? []));
    return { ok: true, value };
  } catch (error) {
    const mapped = mapThrownError(error, artifact, asm);
    return mapped === undefined
      ? { ok: false, error: message(error) }
      : { ok: false, error: message(error), mapped };
  }
}

/**
 * Runtime-stamped origin occurrence carried on an occurrence-aware context.
 * `null` marks a direct business-operation call (no occurrence); any other
 * value must be the non-empty id of the admitted occurrence being executed
 * (L3 S9b addendum: runtime-stamped, null direct).
 */
export interface OccurrenceScope {
  readonly originOccurrence: OccurrenceId | null;
}

/**
 * Handler context carrying the runtime stamp. Structural extension only —
 * `./context.js` is untouched; executors build this via
 * `./executors.js` `withOriginOccurrence`.
 */
export type OccurrenceContext = HandlerContext & OccurrenceScope;

/**
 * Invoke callable `id` as `fn(ctx, ...args)` where `fn` is resolved through
 * the module's `canApp()` registry object (DESIGN §13): import the
 * callable's module, call its `canApp()` export once, then walk the
 * callable's `member` path segments into the returned registry and require
 * a function at the end. Module `export` bindings are identity consts
 * (strings), never implementations — there is deliberately NO fallback to
 * `mod[export]`. Never throws: every resolution and handler failure is
 * returned as `{ ok: false, error }`, naming the callable id, the full
 * member path, and which segment failed.
 */
export async function invokeCallable(
  asm: AssembledModules,
  artifact: CompileArtifact,
  id: string,
  ctx: HandlerContext,
  args?: unknown[],
): Promise<InvokeResult> {
  return invokeWith(asm, artifact, id, ctx, args);
}

/**
 * Occurrence-aware entry used by `./executors.js`: validates the
 * `originOccurrence` stamp, then invokes exactly like `invokeCallable`
 * (same registry resolution, same `fn(ctx, ...args)` call, same
 * never-throws contract). The stamp reaches the fenced commit through the
 * dispatch-producing store the executors install on `ctx`.
 */
export async function invokeCallableInOccurrence(
  asm: AssembledModules,
  artifact: CompileArtifact,
  id: string,
  ctx: OccurrenceContext,
  args?: unknown[],
): Promise<InvokeResult> {
  const origin: unknown = ctx.originOccurrence;
  if (origin !== null && (typeof origin !== "string" || origin.length === 0)) {
    return {
      ok: false,
      error:
        `callable ${JSON.stringify(id)} has no valid originOccurrence ` +
        `(must be null or a non-empty string); ` +
        `occurrence executions must thread the runtime stamp`,
    };
  }
  return invokeWith(asm, artifact, id, ctx, args);
}

/* ------------------------------------------------------------------ */
/* T16b canonical operation path (L7 routing join).                     */
/*                                                                      */
/* T16 closes the T01 direct-invocation gap for GENERATED operations:   */
/* an artifact carrying T15a descriptors (`operations[]` AND `models[]` */
/* present — the compiler always emits both keys) executes through the  */
/* canonical state path (admit -> execute -> receipt) consumed from     */
/* `@canlang/state` dist below. No second interpreter, no alternate     */
/* engine: this section loads T16a's registry/admission/invoke/pipeline */
/* producers and supplies the two L7-owned seams (generated-policy      */
/* mapping, scenario-handler execution). T17b: descriptor-less          */
/* artifacts (either key absent) REFUSE at the assembly router (the     */
/* interim direct path is retired); the direct entries above stay as    */
/* the scenario seam's handler-execution mechanism only.                */
/*                                                                      */
/* Admission authorization (T04a §3: "until T16 maps generated          */
/* policy"): the descriptor intake carries no `by`, so L7 transcribes   */
/* the emitted `canApp().policy.operations[name]` manifest. The         */
/* transcription covers exactly the established subset — absent entry   */
/* (the emitter returns None iff the operation carries no admission     */
/* content at all) admits `public`; Role-only `by` spellings map        */
/* 1:1 (builtins literal, declared roles to `{role}`, multiples to      */
/* `{and}` — the emitter joins guards with `&&`); anything else         */
/* (`gated`, `when`, `requires`, malformed or unknown members) refuses  */
/* the whole set LOUD at load, naming T04b, instead of running          */
/* unguarded. Scenario operations admit `public` at the canonical gate  */
/* because their emitted handler still runs its full inlined gate       */
/* (interim-exact); CRUD operations skip their handler (the pipeline    */
/* executes), so the transcribed gate is their only guard. This join    */
/* also fixes three interim deny-all bugs in the direction of the       */
/* established L3 semantics: `by owner`/`authenticated`/`public` never  */
/* match the interim memberships array but evaluate correctly here.     */
/*                                                                      */
/* Scenario execution: the emitted handler runs as the canonical        */
/* `execute` seam with a live-store-wins context (caller from the       */
/* admitted context, memberships re-read from the live reader — never   */
/* from identity claims), a commit-guarded store, and (T17b) the        */
/* canonical effects scope: stdlib writes stage through the pipeline    */
/* into the scenario effects and `records()` serves through            */
/* `invokeRead` over the staged overlay; the ONE fenced commit carries  */
/* the scenario receipt. Direct `StoragePort` commits inside canonical  */
/* execution still fail loud (genuinely-unknown callers only — the      */
/* migrated stdlib never touches `commit`). Handler failures map to    */
/* rejected receipts (same rule as the assembly's `toBusinessError`),   */
/* so identical envelopes replay rejections. T17b: reads serve through  */
/* `invokeReadCanonical` (transcribed PolicyTable, ruled models refuse  */
/* loud naming T04b) — the query-port refusal stub is retired.          */
/*                                                                      */
/* Version fulfillment (T04a §7): the seven contract pins are           */
/* restated below and asserted EXACTLY against the loaded contracts     */
/* copy (never a silent fallback); `requires[]` entries for the five    */
/* pin-mapped capabilities must match the provided version exactly,     */
/* unknown capability ids reject, and `canlang.builtins` is             */
/* shape-checked only — the runtime has no builtins-catalog-major       */
/* constant to match its `min_version` against (T16c gap).              */
/* ------------------------------------------------------------------ */

/**
 * Mirror of `ByPredicate` (`packages/state/src/policy/roles.ts:23`).
 * `@canlang/state` is not a dependency of this package, so the shape is
 * restated; the loader validates every value at runtime, so drift fails
 * loud at load instead of mis-authorizing.
 */
export type CanonicalByPredicate =
  | "members"
  | "owner"
  | "authenticated"
  | "public"
  | { readonly role: string }
  | { readonly roleSubject: { readonly role: string; readonly person: string } }
  | { readonly and: ReadonlyArray<CanonicalByPredicate> }
  | { readonly or: ReadonlyArray<CanonicalByPredicate> }
  | { readonly not: CanonicalByPredicate };

/**
 * Mirror of `MembershipReader`
 * (`packages/state/src/policy/roles.ts:18`): the structural subset of
 * the L6 `IdentityStore` admission consumes. The real store satisfies
 * this structurally; the canonical entry validates the shape and fails
 * loud on anything else.
 */
export interface CanonicalMembershipReader {
  findMembership(teamId: string, userId: string): Promise<Membership | null>;
}

/**
 * T16b router predicate: true for T15a-generated artifacts (BOTH
 * descriptor keys present — the compiler struct always serializes
 * `operations` and `models`), false for descriptor-less artifacts
 * (interim direct path). Presence (not array-ness) decides: malformed
 * members fail loud inside the canonical loader, never silently.
 */
export function isGeneratedArtifact(artifact: CompileArtifact): boolean {
  const ops: unknown = (artifact as unknown as { operations?: unknown }).operations;
  const models: unknown = (artifact as unknown as { models?: unknown }).models;
  return ops !== undefined && models !== undefined;
}

/* ------------------------------------------------------------------ */
/* Generated-policy transcription (CRUD admission gates).               */
/* ------------------------------------------------------------------ */

/** Built-in `by` spellings (`compiler/src/codegen/ir.rs` `IrGuard::Role`). */
const POLICY_BUILTINS: ReadonlySet<string> = new Set([
  "members",
  "owner",
  "authenticated",
  "public",
]);

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one `canApp().policy.operations[name]` manifest entry off an
 * assembled registry object. Absent `policy` (the emitter omits the
 * member iff roles, models, AND operations are all empty) or an absent
 * entry (the emitter returns None iff the operation carries no
 * admission content at all) both read as `undefined` — sound: either
 * shape guarantees the operation carries no gates. Malformed shapes
 * fail loud, never as an assumed gate.
 */
export function readOperationPolicyEntry(registry: unknown, opName: string): unknown {
  if (!isUnknownRecord(registry)) {
    throw new Error(
      `t16b: operation ${JSON.stringify(opName)}: cannot read admission policy ` +
        `(canApp() registry is not an object)`,
    );
  }
  const policy: unknown = registry["policy"];
  if (policy === undefined || policy === null) return undefined;
  if (!isUnknownRecord(policy)) {
    throw new Error(
      `t16b: operation ${JSON.stringify(opName)}: malformed admission policy ` +
        `(policy member is not an object)`,
    );
  }
  const operations: unknown = policy["operations"];
  if (operations === undefined || operations === null) return undefined;
  if (!isUnknownRecord(operations)) {
    throw new Error(
      `t16b: operation ${JSON.stringify(opName)}: malformed admission policy ` +
        `(policy.operations is not an object)`,
    );
  }
  return operations[opName];
}

/**
 * Transcribe one CRUD manifest entry to its canonical `by` predicate.
 * Absent entry -> `public` (no admission content — the handler ran no
 * check in interim either). Role-only `by` spellings map 1:1
 * (predicate spellings verbatim, declared roles to `{role}`, multiples
 * to `{and}` per the emitter's `&&` join). Every other content —
 * `gated` (subject/expression/compound gates collapsed by the
 * emitter), `when` (the predicate is emitted code, not data),
 * `requires`, malformed shapes, unknown members — refuses LOUD: the
 * pipeline enforces nothing itself, so an untranscribable gate must
 * block the set (T04b carries generated policy) rather than run
 * unguarded. Plain `Error` (caller-side refusal, mirroring the
 * loader's engine-local policy channel).
 */
export function mapCrudPolicyToBy(opName: string, entry: unknown): CanonicalByPredicate {
  if (entry === undefined || entry === null) return "public";
  const where = `t16b: operation ${JSON.stringify(opName)} cannot admit in the T16 core scope (T04b carries generated policy)`;
  if (!isUnknownRecord(entry)) {
    throw new Error(`${where}: malformed policy entry (not an object).`);
  }
  for (const key of Object.keys(entry)) {
    if (key !== "by" && key !== "gated" && key !== "when" && key !== "requires") {
      throw new Error(`${where}: unknown policy member ${JSON.stringify(key)}.`);
    }
  }
  if (entry["gated"] === true) {
    throw new Error(
      `${where}: subject/expression/compound gates have no transcribable spelling.`,
    );
  }
  if (entry["when"] === true) {
    throw new Error(
      `${where}: crud candidate preconditions are emitted code, not admittable data.`,
    );
  }
  const requires: unknown = entry["requires"];
  if (typeof requires === "number" && requires > 0) {
    throw new Error(
      `${where}: handler-enforced require guards cannot run (the pipeline skips the handler).`,
    );
  }
  const spellings: unknown = entry["by"];
  if (spellings === undefined) {
    throw new Error(`${where}: policy entry carries no transcribable by spellings.`);
  }
  if (
    !Array.isArray(spellings) ||
    spellings.length === 0 ||
    !spellings.every((s) => typeof s === "string" && s.length > 0)
  ) {
    throw new Error(
      `${where}: malformed by spellings (non-empty array of non-empty strings).`,
    );
  }
  const terms: CanonicalByPredicate[] = [];
  for (const spelling of spellings as string[]) {
    if (POLICY_BUILTINS.has(spelling)) {
      terms.push(spelling as CanonicalByPredicate);
    } else {
      terms.push({ role: spelling });
    }
  }
  const first: CanonicalByPredicate | undefined = terms[0];
  if (first === undefined) {
    throw new Error(`${where}: malformed by spellings (non-empty array of non-empty strings).`);
  }
  return terms.length === 1 ? first : { and: terms };
}

/* ------------------------------------------------------------------ */
/* T17b read-policy transcription (PolicyTable grants).                 */
/*                                                                      */
/* Mirrors the CRUD by-transcription above, over the `policy.models`    */
/* manifest map (`compiler/src/codegen/js.rs` `emit_policy_member`:     */
/* `models: { Model: { read?: [ruleIds], invariants?: [...], locks?:    */
/* [...] } }`). The emitted read rules are boolean FUNCTIONS (`(c,row)  */
/* => ...` in the registry `read` map) — code, not admittable data,     */
/* exactly like CRUD `when` — so they are NEVER transcribed:            */
/*                                                                      */
/* - Absent entry (or an entry with no `read` member, or an empty       */
/*   `read` array): no read content — transcribe ONE public grant over  */
/*   all declared model fields. Interim-exact: the interim `records()`  */
/*   served full stored rows for these models, and operation admission  */
/*   (`def.by`) still gates the read call itself.                        */
/* - Present non-empty `read` array (well-formed rule ids): the model   */
/*   is RULED — its reads refuse LOUD at serve time with `validation`   */
/*   naming T04b (T04b carries generated policy; serving would run      */
/*   unguarded). Per-read refusal, not whole-set: read rules gate only  */
/*   reads, so CRUD/scenario serving stays up with precise per-read     */
/*   errors (unlike CRUD gates, where the gate is the op's only guard). */
/* - Malformed shapes (non-object entry, unknown members, malformed     */
/*   `read` array): refuse LOUD at preload — the programmer-bug class,  */
/*   mirroring the CRUD malformed handling.                             */
/*                                                                      */
/* Read-`by` posture (T17b decision, recorded): KEEP PUBLIC + GRANTS.   */
/* Read defs keep `by: public` at the canonical gate (T16b preload      */
/* behavior, unchanged — `invokeRead` honors `def.by` either way) and   */
/* visibility for servable models comes from the transcribed grants.    */
/* The rejected alternative (transcribe read gates into `def.by`) is    */
/* unimplementable in the core scope — rule bodies are emitted code —   */
/* and buys nothing: ruled reads refuse either way. Consequence,        */
/* pinned: rule-less models serve full rows to every operation-admitted */
/* caller, including callers the CRUD gates would deny; ruled models    */
/* never serve (loud `validation`, never silent empty).                 */
/*                                                                      */
/* `secretFields` transcribes as `[]`: T15a descriptors carry no secret */
/* marking in the core scope, so there is nothing to transcribe — and   */
/* the engine omits secret-kind VALUES regardless of policy, so no      */
/* secret leaks through the empty list. Grant fields are the model's    */
/* declared field names (the pipeline rejects undeclared fields on      */
/* write, so stored data never exceeds them); metadata always ships in  */
/* the projected record envelope.                                       */
/*                                                                      */
/* Join-point note (T17b finding, T16c-owned): like the CRUD manifest   */
/* above, this reads `canApp().policy` (the T16b join point). DESIGN    */
/* §13 says `canApp()` never spreads `appDefinition`, and the compiler  */
/* emits `policy` only into `appDefinition` — so on current compiler    */
/* output the manifest reads absent here (public transcription). The    */
/* transcription is correct under either source; aligning the join      */
/* point (compiler emits into `canApp`, or the runtime reads            */
/* `appDefinition`) is a cross-lane contract change for T16c, NOT done  */
/* here. See the T17b release report.                                   */
/* ------------------------------------------------------------------ */

/**
 * Read one `canApp().policy.models[model]` manifest entry off an
 * assembled registry object. Absent `policy`/`models`/entry all read as
 * `undefined` (no read content — sound, mirroring the CRUD reader);
 * malformed shapes fail loud, never as an assumed gate.
 */
export function readModelPolicyEntry(registry: unknown, model: string): unknown {
  if (!isUnknownRecord(registry)) {
    throw new Error(
      `t17b: model ${JSON.stringify(model)}: cannot read read policy ` +
        `(canApp() registry is not an object)`,
    );
  }
  const policy: unknown = registry["policy"];
  if (policy === undefined || policy === null) return undefined;
  if (!isUnknownRecord(policy)) {
    throw new Error(
      `t17b: model ${JSON.stringify(model)}: malformed read policy ` +
        `(policy member is not an object)`,
    );
  }
  const models: unknown = policy["models"];
  if (models === undefined || models === null) return undefined;
  if (!isUnknownRecord(models)) {
    throw new Error(
      `t17b: model ${JSON.stringify(model)}: malformed read policy ` +
        `(policy.models is not an object)`,
    );
  }
  return models[model];
}

/** One model's transcribed read posture: servable grants or ruled refusal. */
export interface TranscribedReadPolicy {
  /** True when the model carries read rules (serve-time `validation`, never served). */
  readonly ruled: boolean;
  /** The table-builder input; `null` when ruled (ruled models are omitted from the table). */
  readonly input: CanonicalModelPolicyInput | null;
}

/**
 * Transcribe one model manifest entry to its table-builder input.
 * Absent entry / no `read` member / empty `read` array -> ONE public
 * grant over `declaredFields`. A well-formed non-empty `read` array ->
 * RULED (`ruled: true`, no input — the serve paths refuse loud naming
 * T04b). Malformed shapes and unknown members throw LOUD at preload
 * (the programmer-bug class, mirroring `mapCrudPolicyToBy`). Plain
 * `Error` (caller-side refusal, mirroring the loader's engine-local
 * policy channel).
 */
export function mapReadRulesToPolicy(
  model: string,
  entry: unknown,
  declaredFields: ReadonlyArray<string>,
): TranscribedReadPolicy {
  const where = `t17b: model ${JSON.stringify(model)} cannot serve reads in the T17 core scope (T04b carries generated policy)`;
  const servable = (inputs: CanonicalModelPolicyInput): TranscribedReadPolicy => ({
    ruled: false,
    input: inputs,
  });
  const publicInput = (): CanonicalModelPolicyInput => ({
    model,
    secretFields: [],
    grants: [{ by: "public", fields: [...declaredFields] }],
  });
  if (entry === undefined || entry === null) return servable(publicInput());
  if (!isUnknownRecord(entry)) {
    throw new Error(`${where}: malformed policy entry (not an object).`);
  }
  for (const key of Object.keys(entry)) {
    if (key !== "read" && key !== "invariants" && key !== "locks") {
      throw new Error(`${where}: unknown policy member ${JSON.stringify(key)}.`);
    }
  }
  const rules: unknown = entry["read"];
  if (rules === undefined) return servable(publicInput());
  if (
    !Array.isArray(rules) ||
    !rules.every((rule) => typeof rule === "string" && rule.length > 0)
  ) {
    throw new Error(
      `${where}: malformed read rules (array of non-empty rule ids).`,
    );
  }
  if (rules.length === 0) return servable(publicInput());
  return { ruled: true, input: null };
}

/* ------------------------------------------------------------------ */
/* Dynamic producers (state dist + contracts values).                   */
/* ------------------------------------------------------------------ */

/**
 * State dist producers. Relative dist paths (not bare specifiers):
 * `@canlang/state` has no package link, so only the relative checkout
 * path resolves — in vitest from `src/`, in node from `dist/` (same
 * `../../../` shape), and in the worker via the P-B bundler seam
 * (`env-assembly.ts` precedent).
 */
const STATE_REGISTRY_SPECIFIER = "../../../state/dist/state/src/invocation/registry.js";
const STATE_INVOKE_SPECIFIER = "../../../state/dist/state/src/invocation/invoke.js";
const STATE_CRUD_SPECIFIER = "../../../state/dist/state/src/mutation/crud.js";
const STATE_MODELS_SPECIFIER = "../../../state/dist/state/src/mutation/models.js";
const STATE_ERRORS_SPECIFIER = "../../../state/dist/state/src/errors.js";
/** T17b: bound read port (`createReadInvoker`, the assembly read entry). */
const STATE_TRANSACT_SPECIFIER = "../../../state/dist/state/src/ports/transact.js";
/** T17b: policy-table builder (`buildPolicyTable`, validates transcriptions). */
const STATE_GRANTS_SPECIFIER = "../../../state/dist/state/src/policy/grants.js";
/** T17b: mutation pipeline (`runMutationWrites`, stages scenario writes). */
const STATE_PIPELINE_SPECIFIER = "../../../state/dist/state/src/mutation/pipeline.js";

/** Contracts values (a declared dependency — bare specifier, bundler-inlined). */
const CONTRACTS_SPECIFIER = "@canlang/contracts";

/** Structural view of the state registry module (T16a join surface). */
interface StateRegistryProducer {
  loadArtifactDescriptors(
    artifact: unknown,
    opts: {
      readonly by: (op: { readonly name: string; readonly kind: string }) => CanonicalByPredicate;
    },
  ): {
    readonly registry: ReadonlyMap<string, unknown>;
    readonly models: ReadonlyArray<unknown>;
    readonly refs: ReadonlyMap<string, ReadonlyArray<{ readonly field: string; readonly model: string }>>;
  };
}

/**
 * Admitted-call view the execute seams consume. T17b: the FULL
 * `InvocationContext` (contracts-owned, no mirror drift) — the scenario
 * seam stages stdlib writes under exactly this context, so history
 * entries and receipts carry the admitted operation identity.
 */
export interface CanonicalSeamCall {
  readonly context: InvocationContext;
  readonly def: unknown;
  readonly inputs: Record<string, unknown>;
}

/**
 * Mirror of `ExecutionEffects`
 * (`packages/state/src/invocation/invoke.ts:47`): the provisional
 * outcome one execution pass stages for the fenced commit.
 */
export interface CanonicalExecutionEffects {
  readonly writes: ReadonlyArray<unknown>;
  readonly history: ReadonlyArray<unknown>;
  readonly outbox: ReadonlyArray<unknown>;
  readonly schedules: ReadonlyArray<unknown>;
  readonly uniqueClaims: ReadonlyArray<unknown>;
  readonly uniqueReleases: ReadonlyArray<unknown>;
  readonly resolvedDefaults: Record<string, unknown>;
  readonly result: unknown;
}

/** T17b: structural view of one `invokeRead` served record set. */
export interface CanonicalReadServed {
  readonly records: ProjectedRecord[];
  readonly revision: unknown;
}

/** Structural view of the canonical state invoke module. */
interface StateInvokeProducer {
  invoke(input: {
    readonly registry: ReadonlyMap<string, unknown>;
    readonly envelope: {
      readonly operation: string;
      readonly operation_id: string;
      readonly inputs: Record<string, unknown>;
    };
    readonly identity: ResolvedIdentity;
    readonly app: string;
    readonly source: string;
    readonly store: StoragePort;
    readonly memberships: CanonicalMembershipReader;
    readonly clock: { nowMs(): number };
    readonly execute: (call: CanonicalSeamCall) => Promise<CanonicalExecutionEffects>;
  }): Promise<MutationResult>;
  /** T17b: canonical generated-read entry (scenario `records()` calls it per read). */
  invokeRead(input: {
    readonly registry: ReadonlyMap<string, unknown>;
    readonly envelope: {
      readonly operation: string;
      readonly inputs: Record<string, unknown>;
    };
    readonly identity: ResolvedIdentity;
    readonly policy: unknown;
    readonly store: StoragePort;
    readonly memberships: CanonicalMembershipReader;
  }): Promise<CanonicalReadServed>;
}

/** Structural view of the state CRUD executor module (T16a adapter). */
interface StateCrudProducer {
  generatedCrudExecute(input: {
    readonly table: unknown;
    readonly store: StoragePort;
  }): (call: CanonicalSeamCall) => Promise<CanonicalExecutionEffects>;
}

/** Structural view of the state model-table module (T16a builder). */
interface StateModelsProducer {
  buildModelTableFromCanonical(
    models: ReadonlyArray<unknown>,
    opts: {
      readonly refs: ReadonlyMap<string, ReadonlyArray<{ readonly field: string; readonly model: string }>>;
    },
  ): unknown;
}

/**
 * Structural view of the state errors module. The seam throws REAL
 * `StateError`s (never a same-shaped impostor): canonical invoke
 * decides receipt-vs-propagate by `instanceof`, so only the class from
 * the same dist copy receipts handler failures as rejected outcomes.
 */
interface StateErrorsProducer {
  new (code: string, message: string): Error & { readonly code: string };
}

/** T17b: structural view of the state transaction-port module (bound read port). */
interface StateTransactProducer {
  createReadInvoker(input: {
    readonly registry: ReadonlyMap<string, unknown>;
    readonly policy: unknown;
    readonly store: StoragePort;
    readonly memberships: CanonicalMembershipReader;
  }): (args: {
    readonly envelope: {
      readonly operation: string;
      readonly inputs: Record<string, unknown>;
    };
    readonly identity: ResolvedIdentity;
  }) => Promise<CanonicalReadServed>;
}

/** T17b: one transcribed model policy as handed to the table builder. */
export interface CanonicalModelPolicyInput {
  readonly model: string;
  readonly secretFields: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<{
    readonly by: CanonicalByPredicate;
    readonly fields: ReadonlyArray<string>;
  }>;
}

/**
 * T17b: structural view of the state grants module. The transcription is
 * validated by the REAL `buildPolicyTable` (never hand-rolled): malformed
 * `by`, bad dot paths, or grants over secrets fail loud at preload.
 */
interface StateGrantsProducer {
  buildPolicyTable(policies: ReadonlyArray<CanonicalModelPolicyInput>): unknown;
}

/** T17b: one pipeline write as handed to `runMutationWrites` (no `when`: stdlib carries none). */
export interface CanonicalPipelineWrite {
  readonly op: "create" | "update" | "remove";
  readonly model: string;
  readonly id: string;
  readonly parent?: { readonly model: string; readonly id: string };
  readonly data?: Record<string, unknown>;
}

/** T17b: structural view of one staged domain write (the overlay consumes kind/model/id/row). */
export interface CanonicalStagedDomainWrite {
  readonly kind: string;
  readonly model: string;
  readonly id?: string;
  readonly row?: StoredRow;
  /** T17b: the pipeline's pre-write version basis (update/remove only); collapse passes it through. */
  readonly expectedVersion?: unknown;
}

/** T17b: structural view of one staged unique touch (the seam nets claims/releases per key). */
export interface CanonicalUniqueTouch {
  readonly model: string;
  readonly keyName: string;
  readonly keyValue: string;
}

/** T17b: structural view of the pipeline result (fenced-commit inputs plus receipt defaults). */
export interface CanonicalPipelineResult {
  readonly writes: ReadonlyArray<CanonicalStagedDomainWrite>;
  readonly history: ReadonlyArray<unknown>;
  readonly uniqueClaims: ReadonlyArray<CanonicalUniqueTouch>;
  readonly uniqueReleases: ReadonlyArray<CanonicalUniqueTouch>;
  readonly resolvedDefaults: Record<string, unknown>;
}

/** T17b: structural view of the state mutation-pipeline module. */
interface StatePipelineProducer {
  runMutationWrites(input: {
    readonly table: unknown;
    readonly writes: ReadonlyArray<CanonicalPipelineWrite>;
    readonly context: InvocationContext;
    readonly store: StoragePort;
  }): Promise<CanonicalPipelineResult>;
}

interface CanonicalStateProducers {
  readonly registry: StateRegistryProducer;
  readonly invoke: StateInvokeProducer;
  readonly crud: StateCrudProducer;
  readonly models: StateModelsProducer;
  readonly errors: StateErrorsProducer;
  readonly transact: StateTransactProducer;
  readonly grants: StateGrantsProducer;
  readonly pipeline: StatePipelineProducer;
}

async function loadProducerModule(specifier: string, what: string): Promise<Record<string, unknown>> {
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch {
    throw new Error(
      `t16b: ${what} is not assembled (${specifier}); ` +
        `build @canlang/state dist (root build) or stage the P-B vendor seam — refusing canonical invocation without the state engine`,
    );
  }
  if (!isUnknownRecord(mod)) {
    throw new Error(`t16b: ${what} loaded a non-module namespace (stale dist?)`);
  }
  return mod;
}

function requireProducerFn(
  mod: Record<string, unknown>,
  binding: string,
  what: string,
): (...args: never[]) => unknown {
  const fn: unknown = mod[binding];
  if (typeof fn !== "function") {
    throw new Error(
      `t16b: ${what} lacks function export ${JSON.stringify(binding)} (stale dist?)`,
    );
  }
  return fn as (...args: never[]) => unknown;
}

/** Load and shape-check the eight state producers (fail loud, never partial). */
async function loadCanonicalStateProducers(): Promise<CanonicalStateProducers> {
  const registryMod = await loadProducerModule(STATE_REGISTRY_SPECIFIER, "state registry producer");
  const invokeMod = await loadProducerModule(STATE_INVOKE_SPECIFIER, "state invoke producer");
  const crudMod = await loadProducerModule(STATE_CRUD_SPECIFIER, "state CRUD producer");
  const modelsMod = await loadProducerModule(STATE_MODELS_SPECIFIER, "state models producer");
  const errorsMod = await loadProducerModule(STATE_ERRORS_SPECIFIER, "state errors producer");
  const transactMod = await loadProducerModule(STATE_TRANSACT_SPECIFIER, "state transact producer");
  const grantsMod = await loadProducerModule(STATE_GRANTS_SPECIFIER, "state grants producer");
  const pipelineMod = await loadProducerModule(STATE_PIPELINE_SPECIFIER, "state pipeline producer");
  const loadArtifactDescriptors = requireProducerFn(
    registryMod,
    "loadArtifactDescriptors",
    "state registry producer",
  );
  const invoke = requireProducerFn(invokeMod, "invoke", "state invoke producer");
  const invokeRead = requireProducerFn(invokeMod, "invokeRead", "state invoke producer");
  const generatedCrudExecute = requireProducerFn(
    crudMod,
    "generatedCrudExecute",
    "state CRUD producer",
  );
  const buildModelTableFromCanonical = requireProducerFn(
    modelsMod,
    "buildModelTableFromCanonical",
    "state models producer",
  );
  const StateError = requireProducerFn(errorsMod, "StateError", "state errors producer");
  const createReadInvoker = requireProducerFn(
    transactMod,
    "createReadInvoker",
    "state transact producer",
  );
  const buildPolicyTable = requireProducerFn(
    grantsMod,
    "buildPolicyTable",
    "state grants producer",
  );
  const runMutationWrites = requireProducerFn(
    pipelineMod,
    "runMutationWrites",
    "state pipeline producer",
  );
  return {
    registry: { loadArtifactDescriptors: loadArtifactDescriptors as StateRegistryProducer["loadArtifactDescriptors"] },
    invoke: {
      invoke: invoke as StateInvokeProducer["invoke"],
      invokeRead: invokeRead as StateInvokeProducer["invokeRead"],
    },
    crud: { generatedCrudExecute: generatedCrudExecute as StateCrudProducer["generatedCrudExecute"] },
    models: { buildModelTableFromCanonical: buildModelTableFromCanonical as StateModelsProducer["buildModelTableFromCanonical"] },
    errors: StateError as unknown as StateErrorsProducer,
    transact: { createReadInvoker: createReadInvoker as StateTransactProducer["createReadInvoker"] },
    grants: { buildPolicyTable: buildPolicyTable as StateGrantsProducer["buildPolicyTable"] },
    pipeline: { runMutationWrites: runMutationWrites as StatePipelineProducer["runMutationWrites"] },
  };
}

/* ------------------------------------------------------------------ */
/* Version fulfillment (T04a §7 pins + requires[]).                     */
/* ------------------------------------------------------------------ */

/**
 * The seven T04a pins restated as literals (each cites its owner):
 * execution (`contracts/src/state.ts` `EXECUTION_CONTRACT_VERSION`),
 * artifact (`contracts/src/artifact.ts` `ARTIFACT_VERSION`), state
 * (`contracts/src/state.ts` `STATE_CONTRACT_VERSION`), values
 * (`contracts/src/values.ts` `VALUES_CONTRACT_VERSION`), identity
 * (`contracts/src/identity.ts` `IDENTITY_CONTRACT_VERSION`), wire
 * (`contracts/src/wire.ts` `WIRE_CONTRACT_VERSION`), examples
 * (`contracts/src/examples.ts` `EXAMPLES_CONTRACT_VERSION`). Compared
 * against the LOADED contracts copy (not its own pin table, which
 * would be vacuous): a mixed-version bundle refuses to serve.
 */
const T16B_PINNED_CONTRACTS = {
  execution: 1,
  artifact: 1,
  state: 1,
  values: 1,
  identity: 1,
  wire: 1,
  examples: 1,
} as const;

/** Loaded contracts version constants (dynamic import, validated numbers). */
export interface ContractVersionSet {
  readonly execution: number;
  readonly artifact: number;
  readonly state: number;
  readonly values: number;
  readonly identity: number;
  readonly wire: number;
  readonly examples: number;
}

/** Load the contracts version constants (fail loud on a misshapen copy). */
export async function loadContractVersions(): Promise<ContractVersionSet> {
  const mod = await loadProducerModule(CONTRACTS_SPECIFIER, "contracts version producer");
  const read = (binding: string): number => {
    const value: unknown = mod[binding];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `t16b: contracts version producer lacks numeric ${JSON.stringify(binding)} (stale dist?)`,
      );
    }
    return value;
  };
  return {
    execution: read("EXECUTION_CONTRACT_VERSION"),
    artifact: read("ARTIFACT_VERSION"),
    state: read("STATE_CONTRACT_VERSION"),
    values: read("VALUES_CONTRACT_VERSION"),
    identity: read("IDENTITY_CONTRACT_VERSION"),
    wire: read("WIRE_CONTRACT_VERSION"),
    examples: read("EXAMPLES_CONTRACT_VERSION"),
  };
}

/**
 * Assert the seven T04a pins EXACTLY (T04a §7: exact match, never a
 * silent fallback). Every mismatch is listed in one precise error in
 * fixed contract order — deterministic, no first-only hiding.
 */
export function assertT04aContractPins(provided: ContractVersionSet): void {
  const checks: ReadonlyArray<{ readonly contract: string; readonly actual: number; readonly want: number }> = [
    { contract: "execution", actual: provided.execution, want: T16B_PINNED_CONTRACTS.execution },
    { contract: "artifact", actual: provided.artifact, want: T16B_PINNED_CONTRACTS.artifact },
    { contract: "state", actual: provided.state, want: T16B_PINNED_CONTRACTS.state },
    { contract: "values", actual: provided.values, want: T16B_PINNED_CONTRACTS.values },
    { contract: "identity", actual: provided.identity, want: T16B_PINNED_CONTRACTS.identity },
    { contract: "wire", actual: provided.wire, want: T16B_PINNED_CONTRACTS.wire },
    { contract: "examples", actual: provided.examples, want: T16B_PINNED_CONTRACTS.examples },
  ];
  const mismatched = checks.filter((check) => check.actual !== check.want);
  if (mismatched.length > 0) {
    const detail = mismatched
      .map((check) => `${check.contract} v${check.actual} (want v${check.want})`)
      .join(", ");
    throw new Error(
      `t16b: incompatible contract versions (${detail}); ` +
        `the T16 serving runtime requires exactly the T04a v1 pins — refusing to serve`,
    );
  }
}

/**
 * `requires[]` capability -> pin-mapped contract. Transcribes the
 * compiler's emission (`compute_requires` in
 * `compiler/src/codegen/artifact.rs`: scalar families + `state`, all
 * `min_version` 1) and the lane registry
 * (`src/deploy/installed.ts` `KNOWN_CAPABILITIES`); anything outside
 * this map plus `canlang.builtins` rejects as unknown (T04a §7).
 */
const REQUIRES_CONTRACT_FOR_CAPABILITY: Readonly<Record<string, "state" | "values">> = {
  state: "state",
  "values.decimal": "values",
  "values.int64": "values",
  "values.money": "values",
  "values.temporal": "values",
};

/**
 * Capabilities exempt from version matching: `canlang.builtins`
 * pins the producer catalog MAJOR (currently 2), and the serving
 * runtime has no catalog-major constant to match it against (T16c
 * gap) — shape-checked only, never silently fulfilled.
 */
const REQUIRES_UNVERSIONED: ReadonlySet<string> = new Set(["canlang.builtins"]);

/** Runtime-provided versions for the pin-mapped capabilities. */
export interface RequiresProvidedVersions {
  readonly state: number;
  readonly values: number;
}

/**
 * Assert `requires[]` fulfillment (T04a §7): unknown capability ids
 * reject; pin-mapped capabilities must match the provided version
 * EXACTLY (never `>=` silent drift, never a fallback); unversioned
 * capabilities are shape-checked by the caller and skipped here.
 * Structural entry type (mirrors `ArtifactRequirement` in
 * `contracts/src/artifact.ts` without naming the T15b-held file).
 */
export function assertRequiresFulfilled(
  requires: ReadonlyArray<{ readonly capability: string; readonly min_version: number }>,
  provided: RequiresProvidedVersions,
): void {
  for (const requirement of requires) {
    const capability = requirement.capability;
    if (REQUIRES_UNVERSIONED.has(capability)) continue;
    const contract: "state" | "values" | undefined =
      REQUIRES_CONTRACT_FOR_CAPABILITY[capability];
    if (contract === undefined) {
      throw new Error(
        `t16b: artifact requires unknown capability ${JSON.stringify(capability)} ` +
          `(min_version ${requirement.min_version}); known: ` +
          `canlang.builtins, state, values.decimal, values.int64, values.money, values.temporal`,
      );
    }
    const have = contract === "state" ? provided.state : provided.values;
    if (have !== requirement.min_version) {
      throw new Error(
        `t16b: artifact requires ${JSON.stringify(capability)} min_version ` +
          `${requirement.min_version} but this runtime provides v${have} — refusing to serve`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Commit guard (scenario handlers inside canonical execution).         */
/* ------------------------------------------------------------------ */

/**
 * Wrap `inner` so `commit` fails LOUD while every other port method
 * delegates untouched. A scenario handler that commits directly inside
 * canonical execution would break the admission fence (its writes land
 * at newer revisions than the receipt commit expects) and triple-write
 * across the retry loop, so the guard refuses instead of corrupting —
 * no partial effects are ever committed. Reads
 * (load/query/receipts/history) stay available. T17b: the guard stays
 * for genuinely-unknown callers (direct `c.store.commit` calls); the
 * migrated stdlib data plane never touches `commit` (it stages through
 * the scope), so migrated calls never trip it. Delegation list mirrors
 * `withDispatchProducer` (`./executors.js`); any `StoragePort` member
 * added later must be added here too (tsc enforces the return type).
 */
export function withCanonicalCommitGuard(store: StoragePort, operation: string): StoragePort {
  return {
    readRevision: () => store.readRevision(),
    load: (model, id) => store.load(model, id),
    query: (spec) => store.query(spec),
    commit: () => {
      // T17b: message updated (was: "after the T17 stdlib migration") —
      // the migration LANDED, so the pointer now names the staged rule.
      throw new Error(
        `t17: operation ${JSON.stringify(operation)} attempted a direct state commit ` +
          `inside canonical execution; handler writes stage through the stdlib data plane ` +
          `(create/set/deleteRecord) and commit once with the scenario receipt — direct ` +
          `commits would break the admission fence (no partial effects were committed)`,
      );
    },
    readReceipt: (identity) => store.readReceipt(identity),
    outboxPending: () => store.outboxPending(),
    scheduleGet: (key) => store.scheduleGet(key),
    schedulesDue: (now, limit) => store.schedulesDue(now, limit),
    historyFor: (model, recordId) => store.historyFor(model, recordId),
    readInstalledSnapshot: (owner) => store.readInstalledSnapshot(owner),
    readMigrationProgress: (migrationId) => store.readMigrationProgress(migrationId),
    readStagedRows: (migrationId, cursor, limit) => store.readStagedRows(migrationId, cursor, limit),
    stageMigrationRows: (input) => store.stageMigrationRows(input),
    publishMigrationChunk: (input) => store.publishMigrationChunk(input),
    flipInstalledSnapshot: (input) => store.flipInstalledSnapshot(input),
    readMigrationOutcomes: (migrationId) => store.readMigrationOutcomes(migrationId),
    recordMigrationFailure: (input) => store.recordMigrationFailure(input),
    discardStagedRows: (input) => store.discardStagedRows(input),
    readMigrationFailure: (migrationId) => store.readMigrationFailure(migrationId),
  };
}

/* ------------------------------------------------------------------ */
/* Descriptor preload + canonical mutation entry.                       */
/* ------------------------------------------------------------------ */

/** One `operations[]` entry's routing identity (validated pre-pass view). */
interface PreloadOperation {
  readonly name: string;
  readonly kind: string;
}

/** Callable coherence for one generated operation (the compiler guarantees it). */
interface PreloadCallable {
  readonly module: string;
}

function readPreloadOperations(artifact: CompileArtifact): PreloadOperation[] {
  const raw: unknown = (artifact as unknown as { operations?: unknown }).operations;
  if (!Array.isArray(raw)) {
    throw new Error("t16b: generated artifact operations must be an array (contract violation).");
  }
  const ops: PreloadOperation[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `operations[${index}]`;
    if (!isUnknownRecord(entry) || typeof entry["name"] !== "string" || entry["name"] === "") {
      throw new Error(
        `t16b: generated artifact ${where} needs a non-empty operation name (contract violation).`,
      );
    }
    if (typeof entry["kind"] !== "string" || entry["kind"] === "") {
      throw new Error(
        `t16b: generated artifact ${where} needs a non-empty operation kind (contract violation).`,
      );
    }
    ops.push({ name: entry["name"] as string, kind: entry["kind"] as string });
  }
  return ops;
}

/**
 * Resolve the emitted callable for a generated operation: the id MUST
 * match the operation name with kind `operation` (the emitter links
 * every untrusted scenario and every CRUD op this way; trusted
 * scenarios are event handlers, never user operations). Missing or
 * incoherent callables refuse the set — a generated operation without
 * its emitted counterpart cannot establish admission policy (CRUD) or
 * an executor (scenario).
 */
function resolvePreloadCallable(artifact: CompileArtifact, op: PreloadOperation): PreloadCallable {
  const callables: unknown = (artifact as unknown as { callables?: unknown }).callables;
  if (!Array.isArray(callables)) {
    throw new Error("t16b: generated artifact callables must be an array (contract violation).");
  }
  for (const entry of callables) {
    if (!isUnknownRecord(entry) || entry["id"] !== op.name) continue;
    if (entry["kind"] !== "operation") {
      throw new Error(
        `t16b: operation ${JSON.stringify(op.name)} links callable kind ` +
          `${JSON.stringify(entry["kind"])} (want "operation"); refusing a possibly tampered artifact`,
      );
    }
    if (typeof entry["module"] !== "string" || entry["module"] === "") {
      throw new Error(
        `t16b: operation ${JSON.stringify(op.name)} has no usable callable module (contract violation).`,
      );
    }
    return { module: entry["module"] as string };
  }
  throw new Error(
    `t16b: operation ${JSON.stringify(op.name)} has descriptors but no emitted callable; ` +
      `refusing an incoherent artifact`,
  );
}

/**
 * Import one assembled module's `canApp()` registry for policy
 * reading. Failure shapes mirror `invokeWith` (missing URL, import
 * failure, missing/throwing `canApp`) so operators see one
 * vocabulary across both paths.
 */
async function importPolicyRegistry(
  asm: AssembledModules,
  module: string,
  opName: string,
): Promise<unknown> {
  const where = `operation ${JSON.stringify(opName)} module ${JSON.stringify(module)}`;
  const url: unknown = Object.hasOwn(asm.moduleUrls, module)
    ? (asm.moduleUrls as Record<string, unknown>)[module]
    : undefined;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`t16b: ${where} has no assembled module URL (cannot establish admission policy)`);
  }
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`t16b: ${where} failed to import (${reason})`);
  }
  if (!isUnknownRecord(mod) || typeof mod["canApp"] !== "function") {
    throw new Error(`t16b: ${where} has no canApp() registry (cannot establish admission policy)`);
  }
  try {
    return (mod["canApp"] as () => unknown)();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`t16b: ${where} canApp() threw (${reason})`);
  }
}

/**
 * Loaded canonical set: admission-ready registry plus the model table.
 * T17b: plus the transcribed read policy (`policy`, built by the REAL
 * `buildPolicyTable` — held opaquely, never hand-rolled) and the ruled
 * model set (serve-time refusals — models are omitted from the table so
 * even a missed check serves empty, never rows).
 */
export interface LoadedCanonicalDescriptors {
  readonly registry: ReadonlyMap<string, unknown>;
  readonly table: unknown;
  readonly policy: unknown;
  readonly ruledModels: ReadonlySet<string>;
  readonly producers: CanonicalStateProducers;
}

/**
 * Per-artifact canonical cache. Artifacts are treated as immutable
 * serving units (digest-pinned upstream), so one load per object
 * serves every invocation; the `WeakMap` frees with the artifact.
 * Assembly preloads (failing before serving); standalone invokers
 * load lazily on first canonical call.
 */
const canonicalCache = new WeakMap<CompileArtifact, LoadedCanonicalDescriptors>();

/**
 * T17b: scan every assembled module for `canApp().policy.models` and
 * merge per model (first occurrence wins; a CONTRADICTORY entry for
 * the same model across modules refuses LOUD — fail closed on
 * incoherent policy). Lenient shape, strict errors: modules without a
 * `canApp()` factory (page/asset modules) are skipped, but an import
 * failure, a throwing `canApp()`, or a malformed `policy.models` map
 * throws — policy that cannot be established never degrades to
 * public-by-omission. An empty scan (no registry-bearing modules)
 * yields no entries: rule-less transcription (no policy content was
 * found anywhere to transcribe).
 */
async function collectModelPolicyManifests(asm: AssembledModules): Promise<Map<string, unknown>> {
  const merged = new Map<string, unknown>();
  const fingerprints = new Map<string, string>();
  for (const module of Object.keys(asm.moduleUrls)) {
    const url: unknown = (asm.moduleUrls as Record<string, unknown>)[module];
    if (typeof url !== "string" || url.length === 0) continue;
    let mod: unknown;
    try {
      mod = await import(url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `t17b: module ${JSON.stringify(module)} failed to import while establishing read policy (${reason})`,
      );
    }
    if (!isUnknownRecord(mod) || typeof mod["canApp"] !== "function") continue;
    let registry: unknown;
    try {
      registry = (mod["canApp"] as () => unknown)();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `t17b: module ${JSON.stringify(module)} canApp() threw while establishing read policy (${reason})`,
      );
    }
    if (!isUnknownRecord(registry)) {
      throw new Error(
        `t17b: module ${JSON.stringify(module)} canApp() returned a non-object while establishing read policy`,
      );
    }
    const policy: unknown = registry["policy"];
    if (policy === undefined || policy === null) continue;
    if (!isUnknownRecord(policy)) {
      throw new Error(
        `t17b: module ${JSON.stringify(module)} carries a malformed policy member (not an object)`,
      );
    }
    const models: unknown = policy["models"];
    if (models === undefined || models === null) continue;
    if (!isUnknownRecord(models)) {
      throw new Error(
        `t17b: module ${JSON.stringify(module)} carries a malformed policy.models map (not an object)`,
      );
    }
    for (const [model, entry] of Object.entries(models)) {
      let fingerprint: string;
      try {
        fingerprint = JSON.stringify(entry) ?? "undefined";
      } catch {
        throw new Error(
          `t17b: model ${JSON.stringify(model)} carries a non-serializable read policy entry`,
        );
      }
      const seen = fingerprints.get(model);
      if (seen === undefined) {
        fingerprints.set(model, fingerprint);
        merged.set(model, entry);
      } else if (seen !== fingerprint) {
        throw new Error(
          `t17b: model ${JSON.stringify(model)} carries contradictory read policy across ` +
            `assembled modules (refusing an incoherent set)`,
        );
      }
    }
  }
  return merged;
}

/** T17b: declared data-field names off one loaded canonical model (validated shape, loud on skew). */
function canonicalModelFields(model: unknown, where: string): ReadonlyArray<string> {
  if (!isUnknownRecord(model)) {
    throw new Error(`t17b: ${where} is not an object (loader/artifact skew?)`);
  }
  const fields: unknown = model["fields"];
  if (!isUnknownRecord(fields)) {
    throw new Error(`t17b: ${where} carries no fields map (loader/artifact skew?)`);
  }
  return Object.keys(fields);
}

/** T17b: canonical model name off one loaded canonical model (validated shape, loud on skew). */
function canonicalModelName(model: unknown, index: number): string {
  if (!isUnknownRecord(model) || typeof model["name"] !== "string" || model["name"] === "") {
    throw new Error(
      `t17b: loaded model #${index} carries no non-empty name (loader/artifact skew?)`,
    );
  }
  return model["name"] as string;
}

/**
 * Load a generated artifact's canonical set: transcribe every CRUD
 * admission gate from its emitted policy manifest, verify every
 * scenario operation links an `operation` callable, load descriptors
 * through T16a's canonical loader (whole-set rejection — unknown
 * kinds, malformed or dangling members, untranscribable gates), and
 * build the model table. Reads need no callable (T17b: `invokeRead`
 * serves them through the transcribed `policy` below). Throws precise
 * errors; never a partial set.
 */
export async function loadCanonicalDescriptors(
  asm: AssembledModules,
  artifact: CompileArtifact,
): Promise<LoadedCanonicalDescriptors> {
  const cached = canonicalCache.get(artifact);
  if (cached !== undefined) return cached;
  const producers = await loadCanonicalStateProducers();
  const ops = readPreloadOperations(artifact);
  const crudBy = new Map<string, CanonicalByPredicate>();
  for (const op of ops) {
    if (op.kind === "create" || op.kind === "update" || op.kind === "delete") {
      const callable = resolvePreloadCallable(artifact, op);
      const registry = await importPolicyRegistry(asm, callable.module, op.name);
      crudBy.set(op.name, mapCrudPolicyToBy(op.name, readOperationPolicyEntry(registry, op.name)));
    } else if (op.kind === "scenario") {
      resolvePreloadCallable(artifact, op);
    }
  }
  const loaded = producers.registry.loadArtifactDescriptors(artifact, {
    by: (op) => {
      if (op.kind === "create" || op.kind === "update" || op.kind === "delete") {
        const predicate = crudBy.get(op.name);
        if (predicate === undefined) {
          throw new Error(
            `t16b: operation ${JSON.stringify(op.name)} reached admission without a ` +
              `transcribed gate (loader/artifact skew?)`,
          );
        }
        return predicate;
      }
      // Scenarios admit `public` at the canonical gate — their emitted
      // handler still runs the full inlined gate (interim-exact).
      // Reads admit `public` at the gate (T17b read-by posture: keep
      // public + grants — visibility comes from the transcribed
      // PolicyTable, and `invokeRead` serves them).
      return "public";
    },
  });
  const table = producers.models.buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  // T17b: transcribe the read policy over the LOADED models (validated
  // names + declared fields — never the raw artifact). Ruled models are
  // omitted from the table (fail-closed even under a missed check) and
  // recorded for serve-time refusal; the builder validates every input.
  const manifests = await collectModelPolicyManifests(asm);
  const policyInputs: CanonicalModelPolicyInput[] = [];
  const ruledModels = new Set<string>();
  for (const [index, model] of loaded.models.entries()) {
    const name = canonicalModelName(model, index);
    const transcribed = mapReadRulesToPolicy(
      name,
      manifests.get(name),
      canonicalModelFields(model, `loaded model ${JSON.stringify(name)}`),
    );
    if (transcribed.ruled) {
      ruledModels.add(name);
    } else if (transcribed.input !== null) {
      policyInputs.push(transcribed.input);
    }
  }
  const policy = producers.grants.buildPolicyTable(policyInputs);
  const canonical: LoadedCanonicalDescriptors = {
    registry: loaded.registry,
    table,
    policy,
    ruledModels,
    producers,
  };
  canonicalCache.set(artifact, canonical);
  return canonical;
}

/** `BUSINESS_ERROR_CODES` (`contracts/src/wire.ts`) restated (seam mapping). */
const SEAM_BUSINESS_CODES: ReadonlySet<string> = new Set([
  "validation",
  "forbidden",
  "not_found",
  "conflict",
  "rule_failed",
  "busy",
  "limit",
  "delivery_unknown",
]);

function isSeamBusinessErrorLike(value: unknown): value is { code: string; message: string } {
  if (!isUnknownRecord(value)) return false;
  const code: unknown = value["code"];
  const message: unknown = value["message"];
  return (
    typeof code === "string" &&
    SEAM_BUSINESS_CODES.has(code) &&
    typeof message === "string"
  );
}

/** Minimal store surface canonical execution needs (validated, fail loud). */
function assertCanonicalStore(store: StoragePort, operation: string): void {
  const surface = store as unknown as Record<string, unknown> | null | undefined;
  if (typeof surface !== "object" || surface === null) {
    throw new Error(
      `t16b: operation ${JSON.stringify(operation)} needs a StoragePort for canonical ` +
        `invocation (got a store without it?)`,
    );
  }
  for (const method of ["readRevision", "load", "query", "commit", "readReceipt"] as const) {
    if (typeof surface[method] !== "function") {
      throw new Error(
        `t16b: operation ${JSON.stringify(operation)} needs a StoragePort with ` +
          `${method}() for canonical invocation (got a store without it?)`,
      );
    }
  }
}

/** Minimal membership-reader surface canonical admission needs (fail loud). */
function assertCanonicalMemberships(
  memberships: CanonicalMembershipReader,
  operation: string,
): void {
  const surface = memberships as unknown as Record<string, unknown> | null | undefined;
  if (typeof surface !== "object" || surface === null || typeof surface["findMembership"] !== "function") {
    throw new Error(
      `t16b: operation ${JSON.stringify(operation)} needs a MembershipReader ` +
        `(IdentityStore-backed findMembership) for canonical admission — pass the ` +
        `identity store through; refusing to admit without live membership`,
    );
  }
}

/**
 * Canonical mutation invocation for ONE generated operation:
 * transport-verified identity in, canonical `MutationResult` out.
 * CRUD defs execute through T16a's pipeline adapter; scenario defs
 * through their emitted handler as the execute seam; reads reject via
 * the invoke read-guard; unknown operations reject `validation`.
 * Throws the canonical `StateError` on business outcomes (codes
 * preserved end to end) and plain `Error` on wiring bugs — the
 * assembly maps both through its established `toBusinessError` rule.
 */
export interface CanonicalMutationOpts {
  readonly asm: AssembledModules;
  readonly artifact: CompileArtifact;
  readonly operation: string;
  readonly operationId: string;
  readonly inputs: Record<string, unknown>;
  /** Transport-verified identity (resolved from the credential per request). */
  readonly identity: ResolvedIdentity;
  /** Selected deployment app; part of the receipt identity. */
  readonly app: string;
  /** Serving-source label (MCP path passes `mcp`, standalone `worker`). */
  readonly source: string;
  readonly store: StoragePort;
  readonly memberships: CanonicalMembershipReader;
  readonly now: () => number;
}

function seamDefKind(def: unknown, operation: string): string {
  if (!isUnknownRecord(def)) {
    throw new Error(
      `t16b: operation ${JSON.stringify(operation)} reached execution without a descriptor (wiring bug)`,
    );
  }
  const descriptor: unknown = def["descriptor"];
  if (!isUnknownRecord(descriptor) || typeof descriptor["kind"] !== "string") {
    throw new Error(
      `t16b: operation ${JSON.stringify(operation)} reached execution without a descriptor kind (wiring bug)`,
    );
  }
  return descriptor["kind"] as string;
}

/* ------------------------------------------------------------------ */
/* T17b staged overlay + effects collector (scenario data plane).       */
/*                                                                      */
/* One scenario execution stages N stdlib writes through per-call       */
/* pipeline runs. Each run layers over the STAGED OVERLAY (staged rows  */
/* win, staged removes mask, everything else falls through to the       */
/* store), so later calls see earlier ones (read-your-write) and        */
/* `records()` serves staged rows with full engine grant projection.    */
/* Per-call runs are sound because canonical tables carry no hooks,     */
/* invariants, or locks (engine-local empty in the core scope —         */
/* `buildModelTableFromCanonical`), so no intermediate run can          */
/* spuriously fail a whole-batch check; uniques net at the seam         */
/* (below) and resolved defaults key per write.                         */
/* ------------------------------------------------------------------ */

/** T17b: staged-row view one execution layers over the store (`null` masks a staged remove). */
type StagedRowView = ReadonlyMap<string, StoredRow | null>;

function stagedKey(model: string, id: string): string {
  return `${model}\0${id}`;
}

/**
 * T17b: layer `staged` over `store` for pipeline + read fetches. `load`
 * prefers staged rows (staged removes read as `null`); `query` merges
 * staged rows over the base result set (inserts appear, updates
 * replace, removes drop, staged-archived rows honor the spec's
 * archived rule) — merge order is irrelevant because the engine sorts
 * in memory post-fetch. Whole-model fetches ONLY: specs carrying
 * `where`/`limit` refuse LOUD (the overlay cannot filter staged rows;
 * refusing instead of mis-serving) — the only consumers (pipeline
 * scans, whole-model `invokeRead` fetches) never send them. `commit`
 * refuses LOUD: the overlay is read-only; commits flow through the
 * scenario receipt. Every other port method delegates untouched
 * (delegation list mirrors the commit guard; tsc enforces it).
 */
export function withStagedOverlay(store: StoragePort, staged: StagedRowView): StoragePort {
  return {
    readRevision: () => store.readRevision(),
    load: async (model, id) => {
      const key = stagedKey(model as string, id as string);
      const entry = staged.get(key);
      if (entry !== undefined) return entry;
      return store.load(model, id);
    },
    query: async (spec) => {
      if (spec.where !== undefined || spec.limit !== undefined) {
        throw new Error(
          `t17b: staged overlay cannot serve filtered fetches (where/limit over staged rows ` +
            `would mis-serve); whole-model fetches only`,
        );
      }
      const base = await store.query(spec);
      const merged = new Map<string, StoredRow>();
      for (const row of base) {
        merged.set(row.id as string, row);
      }
      const prefix = `${spec.model as string}\0`;
      for (const [key, entry] of staged) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (entry === null) {
          merged.delete(id);
        } else if (spec.archived !== "include" && entry.archivedAt !== null) {
          merged.delete(id);
        } else {
          merged.set(id, entry);
        }
      }
      return [...merged.values()];
    },
    commit: () => {
      throw new Error(
        `t17b: staged overlay is read-only; scenario commits flow through the canonical ` +
          `receipt (no partial effects were committed)`,
      );
    },
    readReceipt: (identity) => store.readReceipt(identity),
    outboxPending: () => store.outboxPending(),
    scheduleGet: (key) => store.scheduleGet(key),
    schedulesDue: (now, limit) => store.schedulesDue(now, limit),
    historyFor: (model, recordId) => store.historyFor(model, recordId),
    readInstalledSnapshot: (owner) => store.readInstalledSnapshot(owner),
    readMigrationProgress: (migrationId) => store.readMigrationProgress(migrationId),
    readStagedRows: (migrationId, cursor, limit) => store.readStagedRows(migrationId, cursor, limit),
    stageMigrationRows: (input) => store.stageMigrationRows(input),
    publishMigrationChunk: (input) => store.publishMigrationChunk(input),
    flipInstalledSnapshot: (input) => store.flipInstalledSnapshot(input),
    readMigrationOutcomes: (migrationId) => store.readMigrationOutcomes(migrationId),
    recordMigrationFailure: (input) => store.recordMigrationFailure(input),
    discardStagedRows: (input) => store.discardStagedRows(input),
    readMigrationFailure: (migrationId) => store.readMigrationFailure(migrationId),
  };
}

/** T17b: one staged unique touch in call order (the collector logs releases-then-claims per call). */
export interface CanonicalStagedUniqueTouch {
  readonly kind: "claim" | "release";
  readonly touch: CanonicalUniqueTouch;
}

/**
 * T17b: net staged unique touches per key (the pipeline's documented
 * caller duty: "scenarios will stage net uniques" — stores apply
 * releases first, so an unnetted create+remove pair would land a GHOST
 * claim). The log arrives in TRUE call order (the collector appends
 * each call's releases-then-claims); per unique key, every release is
 * kept (idempotent frees) and only claims AFTER the last release are
 * kept — a create+remove pair nets to a bare release (no-op), a
 * remove+recreate pair keeps both (free then retake), a key move keeps
 * its release+claim, and competing live claims all survive to conflict
 * honestly at commit.
 */
export function netStagedUniques(
  log: ReadonlyArray<CanonicalStagedUniqueTouch>,
): { claims: CanonicalUniqueTouch[]; releases: CanonicalUniqueTouch[] } {
  const byKey = new Map<string, CanonicalStagedUniqueTouch[]>();
  for (const entry of log) {
    const key = `${entry.touch.model}\0${entry.touch.keyName}\0${entry.touch.keyValue}`;
    const sequence = byKey.get(key);
    if (sequence === undefined) {
      byKey.set(key, [entry]);
    } else {
      sequence.push(entry);
    }
  }
  const netClaims: CanonicalUniqueTouch[] = [];
  const netReleases: CanonicalUniqueTouch[] = [];
  for (const sequence of byKey.values()) {
    let lastRelease = -1;
    for (const [index, entry] of sequence.entries()) {
      if (entry.kind === "release") lastRelease = index;
    }
    for (const [index, entry] of sequence.entries()) {
      if (entry.kind === "release") {
        netReleases.push(entry.touch);
      } else if (index > lastRelease) {
        netClaims.push(entry.touch);
      }
    }
  }
  return { claims: netClaims, releases: netReleases };
}

/**
 * T17b: collapse staged writes to ONE net write per row (call order in,
 * row order out). Canonical invoke commits `effects.writes` verbatim
 * and the store validates EVERY non-insert `expectedVersion` against
 * PRE-batch state — so a merged create+set pair (`insert v1`, `update`
 * basis v1) can never commit as two writes: the update's basis names a
 * row the pre-batch store never held. The seam therefore folds each
 * row's touch sequence (first touch fixes the pre-basis: insert means
 * no pre-row, update/remove carries it in `expectedVersion`):
 * insert+updates become one insert of the final row; updates become one
 * update on the first basis with the final row; a trailing remove
 * becomes one remove on the first basis (or NOTHING when the row was
 * created in-scenario); remove+recreate keeps the committable pair
 * (remove on the first basis + insert of the final row — the store
 * applies sequentially, so this is the one legal two-write shape).
 * History is NOT collapsed: every touch keeps its entry (the audit
 * trail shows what the scenario did, keyed by the scenario identity).
 * Legality is enforced at STAGE time (the pipeline refuses create over
 * a staged row and update/remove of a staged remove through the
 * overlay), so impossible sequences below throw wiring bugs, never
 * silent folds.
 */
export function collapseStagedWrites(
  writes: ReadonlyArray<CanonicalStagedDomainWrite>,
): CanonicalStagedDomainWrite[] {
  const byRow = new Map<string, CanonicalStagedDomainWrite[]>();
  for (const write of writes) {
    const id = write.kind === "insert" ? write.row?.id : write.id;
    if (typeof write.model !== "string" || typeof id !== "string") {
      throw new Error(`t17b: staged write lost its model/id (pipeline/dist skew?)`);
    }
    const key = `${write.model}\0${id}`;
    const sequence = byRow.get(key);
    if (sequence === undefined) {
      byRow.set(key, [write]);
    } else {
      sequence.push(write);
    }
  }
  const collapsed: CanonicalStagedDomainWrite[] = [];
  for (const sequence of byRow.values()) {
    const first = sequence[0];
    if (first === undefined) {
      throw new Error(`t17b: staged row sequence is empty (seam wiring bug).`);
    }
    const id = first.kind === "insert" ? first.row?.id : first.id;
    if (typeof id !== "string") {
      throw new Error(`t17b: staged write lost its model/id (pipeline/dist skew?)`);
    }
    const preExists = first.kind !== "insert";
    let lastRemove = -1;
    for (const [index, touch] of sequence.entries()) {
      if (touch.kind === "remove") lastRemove = index;
    }
    if (lastRemove === sequence.length - 1) {
      // Final state removed: one remove on the first basis, or nothing
      // when the row was created in-scenario (net no-op).
      if (preExists) {
        if (first.expectedVersion === undefined) {
          throw new Error(`t17b: staged ${first.kind} lost its expectedVersion (pipeline/dist skew?)`);
        }
        collapsed.push({
          kind: "remove",
          model: first.model,
          id,
          expectedVersion: first.expectedVersion,
        });
      }
      continue;
    }
    const last = sequence[sequence.length - 1];
    const finalRow = last?.row;
    if (last === undefined || finalRow === undefined) {
      throw new Error(`t17b: staged ${last?.kind ?? "?"} lost its row (pipeline/dist skew?)`);
    }
    if (lastRemove === -1) {
      if (!preExists) {
        collapsed.push({ kind: "insert", model: first.model, row: finalRow });
      } else {
        if (first.expectedVersion === undefined) {
          throw new Error(`t17b: staged ${first.kind} lost its expectedVersion (pipeline/dist skew?)`);
        }
        collapsed.push({
          kind: "update",
          model: first.model,
          id,
          expectedVersion: first.expectedVersion,
          row: finalRow,
        });
      }
      continue;
    }
    // Remove+recreate: the store applies sequentially, so remove-on-basis
    // + insert-final commits. Post-remove touches MUST start with an
    // insert (stage-time pipeline refuses anything else over a staged
    // remove); anything else is a skew.
    const revived = sequence[lastRemove + 1];
    if (revived?.kind !== "insert") {
      throw new Error(`t17b: staged ${revived?.kind ?? "?"} after a staged remove (pipeline/dist skew?)`);
    }
    if (preExists) {
      if (first.expectedVersion === undefined) {
        throw new Error(`t17b: staged ${first.kind} lost its expectedVersion (pipeline/dist skew?)`);
      }
      collapsed.push({
        kind: "remove",
        model: first.model,
        id,
        expectedVersion: first.expectedVersion,
      });
    }
    collapsed.push({ kind: "insert", model: first.model, row: finalRow });
  }
  return collapsed;
}

/** T17b: ruled-model serve-time refusal (loud `validation`, never silent empty). */
function ruledReadRefusal(
  StateError: StateErrorsProducer,
  model: string,
): Error & { readonly code: string } {
  return new StateError(
    "validation",
    `t17b: model ${JSON.stringify(model)} carries read rules (emitted code, not admittable ` +
      `data); its reads serve when T04b carries generated policy — refusing instead of running unguarded.`,
  );
}

/** T17b: whole-model read operation for one served model (`<Model>.read`, or null when not a read). */
function readModelForOperation(operation: string): string | null {
  if (!operation.endsWith(".read") || operation.length === ".read".length) return null;
  return operation.slice(0, -".read".length);
}

/**
 * T17b: refuse unservable `records()` shapes LOUD with `validation`
 * (T04a carries no filter vocabulary; T04b does). Client-side
 * filtering would mis-serve: the engine evaluates `where` over
 * projected values and FAILS limit overflow instead of truncating, so
 * neither can be reproduced outside the engine.
 */
function assertServableReadQuery(
  StateError: StateErrorsProducer,
  query: CanonicalReadQuery,
): void {
  if (query.where !== undefined) {
    throw new StateError(
      "validation",
      `t17b: records() with where= cannot serve in the T17 core scope (T04a carries no ` +
        `filter vocabulary; T04b does) — refusing instead of mis-serving.`,
    );
  }
  if (query.order !== undefined) {
    throw new StateError(
      "validation",
      `t17b: records() with order= cannot serve in the T17 core scope (T04a carries no ` +
        `filter vocabulary; T04b does) — refusing instead of mis-serving.`,
    );
  }
  if (query.limit !== undefined) {
    throw new StateError(
      "validation",
      `t17b: records() with limit= cannot serve in the T17 core scope (the engine fails ` +
        `limit overflow instead of truncating, so a client slice would mis-serve; T04b carries ` +
        `filter inputs) — refusing instead of mis-serving.`,
    );
  }
  if (query.archived === "include") {
    throw new StateError(
      "validation",
      `t17b: records() with archived 'include' cannot serve (canonical reads exclude ` +
        `archived rows) — refusing instead of mis-serving.`,
    );
  }
  if (query.authority === "owner") {
    throw new StateError(
      "validation",
      `t17b: records() with authority 'owner' cannot serve (the owner bypass stays ` +
        `engine-internal — T32 owns authority fences); reads serve viewer-projected.`,
    );
  }
}

/**
 * Scenario execute seam: run the emitted handler with a
 * live-store-wins context (caller from the ADMITTED context,
 * memberships re-read from the live reader — identity claims are
 * never trusted for authorization facts), the commit-guarded
 * STAGING-AWARE store (raw loads/whole-model queries merge staged
 * rows over live state, so handlers keep interim read-your-write;
 * commits trip the guard), and (T17b) the canonical effects scope:
 * stdlib writes stage through
 * the pipeline into the collected effects and `records()` serves
 * through `invokeRead` over the staged overlay. The admitted
 * (normalized) inputs flow to the handler under the interim projection
 * shape (`{operation_id, inputs}`), so handler contracts are
 * unchanged. Handler failures map to REAL `StateError`s: uncaught
 * engine failures attribute message-exactly and receipt with their
 * TRUE codes (parity with the CRUD path); anything the handler throws
 * itself becomes `rule_failed` with its message (the assembly's
 * established unexpected-failure rule). Canonical invoke persists
 * them as rejected receipts and identical envelopes replay the
 * rejection instead of re-executing. Staged writes COLLAPSE per row
 * into the returned effects (one net write per row — the store checks
 * every basis against pre-batch state; uniques netted; resolved
 * defaults keyed per write as `<callIndex>:<model>.<field>`); every
 * touch keeps its history entry. The ONE fenced commit carries the
 * scenario operation identity into history + receipt.
 */
async function runScenarioSeam(
  loaded: LoadedCanonicalDescriptors,
  opts: CanonicalMutationOpts,
  call: CanonicalSeamCall,
): Promise<CanonicalExecutionEffects> {
  const actorUserId = call.context.actor?.userId ?? null;
  const teamId = call.context.team?.teamId ?? null;
  let grants: string[] = [];
  if (actorUserId !== null && teamId !== null) {
    const membership = await opts.memberships.findMembership(teamId, actorUserId);
    if (membership !== null && membership.status === "active") {
      grants = membership.roles.map((grant) => grant.role);
    }
  }
  const StateError = loaded.producers.errors;
  // T17b engine-failure attribution: `invokeWith` stringifies handler
  // failures (`message(error)`), so a propagated engine `StateError`
  // would lose its code at the seam. The scope records every engine
  // failure it raises (message -> error); on handler failure the seam
  // rethrows the RECORDED error on message-exact match, so uncaught
  // engine failures receipt with their TRUE codes (parity with the
  // CRUD path, where execute throws straight to invoke). Anything the
  // handler throws itself (no match) maps to `rule_failed` with its
  // message — the assembly's established unexpected-failure rule.
  // Edge: a handler that catches an engine failure and rethrows a NEW
  // error with the byte-identical message receipts with the engine's
  // code (indistinguishable from propagation — the receipt then says
  // exactly what propagation would have said).
  const engineFailures = new Map<string, Error & { readonly code: string }>();
  const recordEngineFailure = (error: unknown): void => {
    if (error instanceof StateError) {
      engineFailures.set(error.message, error);
    }
  };
  const staged: Map<string, StoredRow | null> = new Map();
  const overlay = withStagedOverlay(opts.store, staged);
  const stagedWrites: CanonicalStagedDomainWrite[] = [];
  const stagedHistory: unknown[] = [];
  const stagedTouches: CanonicalStagedUniqueTouch[] = [];
  const resolvedDefaults: Record<string, unknown> = {};
  let callIndex = 0;
  const applyStagedWrite = (write: CanonicalStagedDomainWrite): StoredRow | null => {
    if (typeof write.kind !== "string" || typeof write.model !== "string") {
      throw new Error(`t17b: staged write lost its kind/model (pipeline/dist skew?)`);
    }
    if (write.kind === "insert" || write.kind === "update") {
      const row: unknown = write.row;
      if (!isUnknownRecord(row) || typeof row["id"] !== "string") {
        throw new Error(`t17b: staged ${write.kind} lost its row (pipeline/dist skew?)`);
      }
      const stagedRow = row as unknown as StoredRow;
      staged.set(stagedKey(write.model, row["id"] as string), stagedRow);
      return stagedRow;
    }
    if (write.kind === "remove") {
      if (typeof write.id !== "string") {
        throw new Error(`t17b: staged remove lost its id (pipeline/dist skew?)`);
      }
      staged.set(stagedKey(write.model, write.id), null);
      return null;
    }
    throw new Error(
      `t17b: staged write kind ${JSON.stringify(write.kind)} is not a domain write (pipeline/dist skew?)`,
    );
  };
  const scope: CanonicalEffectsScope = {
    operation: opts.operation,
    operationId: call.context.operationId,
    stageWrite: async (write: CanonicalStagedWrite): Promise<StoredRow | null> => {
      try {
        if (write.op !== "create" && write.op !== "update" && write.op !== "remove") {
          throw new Error(`t17b: stageWrite needs op create/update/remove (wiring bug).`);
        }
        if (typeof write.model !== "string" || write.model === "") {
          throw new Error(`t17b: stageWrite needs a non-empty string model (wiring bug).`);
        }
        if (typeof write.id !== "string" || write.id === "") {
          throw new Error(`t17b: stageWrite needs a non-empty string record id (wiring bug).`);
        }
        const result = await loaded.producers.pipeline.runMutationWrites({
          table: loaded.table,
          writes: [
            {
              op: write.op,
              model: write.model,
              id: write.id,
              ...(write.parent === undefined ? {} : { parent: write.parent }),
              ...(write.data === undefined ? {} : { data: write.data }),
            },
          ],
          context: call.context,
          store: overlay,
        });
        const first = result.writes[0];
        if (first === undefined) {
          throw new Error(`t17b: pipeline staged no write for one submitted write (pipeline/dist skew?)`);
        }
        stagedWrites.push(...result.writes);
        stagedHistory.push(...result.history);
        for (const touch of result.uniqueReleases) {
          stagedTouches.push({ kind: "release", touch });
        }
        for (const touch of result.uniqueClaims) {
          stagedTouches.push({ kind: "claim", touch });
        }
        const callTag = `${callIndex}:${write.model}`;
        callIndex += 1;
        for (const [field, value] of Object.entries(result.resolvedDefaults)) {
          resolvedDefaults[`${callTag}.${field}`] = value;
        }
        let returned: StoredRow | null = null;
        for (const stagedWrite of result.writes) {
          returned = applyStagedWrite(stagedWrite);
        }
        return returned;
      } catch (error) {
        recordEngineFailure(error);
        throw error;
      }
    },
    readModel: async (
      model: string,
      query: CanonicalReadQuery,
    ): Promise<ReadonlyArray<ProjectedRecord>> => {
      try {
        if (typeof model !== "string" || model === "") {
          throw new Error(`t17b: readModel needs a non-empty string model (wiring bug).`);
        }
        assertServableReadQuery(StateError, query);
        if (loaded.ruledModels.has(model)) {
          throw ruledReadRefusal(StateError, model);
        }
        const served = await loaded.producers.invoke.invokeRead({
          registry: loaded.registry,
          envelope: { operation: `${model}.read`, inputs: {} },
          identity: opts.identity,
          policy: loaded.policy,
          store: overlay,
          memberships: opts.memberships,
        });
        if (!Array.isArray(served.records)) {
          throw new Error(`t17b: invokeRead served no records array (invoke/dist skew?)`);
        }
        return served.records;
      } catch (error) {
        recordEngineFailure(error);
        throw error;
      }
    },
  };
  const ctx = createContext({
    caller:
      actorUserId === null
        ? { userId: "anonymous", roles: [] }
        : { userId: actorUserId, roles: grants },
    store: withCanonicalCommitGuard(overlay, opts.operation),
    clock: opts.now,
    memberships: grants,
    canonical: scope,
  });
  const outcome = await invokeWith(opts.asm, opts.artifact, opts.operation, ctx, [
    { operation_id: call.context.operationId, inputs: call.inputs },
  ]);
  if (!outcome.ok) {
    // Attributed engine failure first: an uncaught engine `StateError`
    // propagates verbatim, so its message matches the recorded one
    // exactly and the ORIGINAL error (true code) receipts.
    if (typeof outcome.error === "string") {
      const recorded = engineFailures.get(outcome.error);
      if (recorded !== undefined) throw recorded;
    }
    // BusinessError-shaped values keep code+message — defensive only:
    // `invokeWith` stringifies handler failures today, so this branch
    // cannot fire for direct handler throws (attribution above covers
    // them); it stays for a future object-preserving invoke entry.
    if (isSeamBusinessErrorLike(outcome.error)) {
      throw new StateError(outcome.error.code, outcome.error.message);
    }
    const message =
      typeof outcome.error === "string" && outcome.error !== ""
        ? outcome.error
        : "The operation was rejected.";
    throw new StateError("rule_failed", message);
  }
  const uniques = netStagedUniques(stagedTouches);
  return {
    writes: collapseStagedWrites(stagedWrites),
    history: stagedHistory,
    outbox: [],
    schedules: [],
    uniqueClaims: uniques.claims,
    uniqueReleases: uniques.releases,
    resolvedDefaults,
    result: outcome.value,
  };
}

export async function invokeMutationCanonical(
  opts: CanonicalMutationOpts,
): Promise<MutationResult> {
  assertCanonicalStore(opts.store, opts.operation);
  assertCanonicalMemberships(opts.memberships, opts.operation);
  const loaded = await loadCanonicalDescriptors(opts.asm, opts.artifact);
  const crudExecute = loaded.producers.crud.generatedCrudExecute({
    table: loaded.table,
    store: opts.store,
  });
  const StateError = loaded.producers.errors;
  return loaded.producers.invoke.invoke({
    registry: loaded.registry,
    envelope: {
      operation: opts.operation,
      operation_id: opts.operationId,
      inputs: opts.inputs,
    },
    identity: opts.identity,
    app: opts.app,
    source: opts.source,
    store: opts.store,
    memberships: opts.memberships,
    clock: { nowMs: opts.now },
    execute: async (call: CanonicalSeamCall): Promise<CanonicalExecutionEffects> => {
      const kind = seamDefKind(call.def, opts.operation);
      if (kind === "create" || kind === "update" || kind === "delete") {
        return crudExecute(call);
      }
      if (kind === "scenario") {
        return runScenarioSeam(loaded, opts, call);
      }
      // Reads never reach the seam (the invoke read-guard rejects
      // first); unknown kinds never load. Defensive, unreachable.
      throw new StateError(
        "validation",
        `Operation ${JSON.stringify(opts.operation)} cannot execute here.`,
      );
    },
  });
}

/* ------------------------------------------------------------------ */
/* T17b canonical read entry (assembly flip target).                    */
/* ------------------------------------------------------------------ */

/**
 * Canonical read invocation for ONE generated read operation:
 * transport-verified identity in, served records + fence revision out.
 * Ruled models refuse LOUD here (`validation` naming T04b — the
 * refusal lives L7-side so the engine keeps its fail-closed
 * policy-miss rule untouched); everything else binds the canonical
 * read port (`createReadInvoker`) over the call's store + live
 * memberships and delegates routing (unknown operations,
 * mutation-envelope mismatches), admission (`def.by`), closed-shape
 * validation, and viewer projection to `invokeRead`. Reads commit
 * nothing and receipt nothing. Throws the canonical `StateError` on
 * business outcomes and plain `Error` on wiring bugs — the assembly
 * maps both through its established `toBusinessError` rule.
 */
export interface CanonicalReadOpts {
  readonly asm: AssembledModules;
  readonly artifact: CompileArtifact;
  readonly operation: string;
  readonly inputs: Record<string, unknown>;
  /** Transport-verified identity (resolved from the credential per request). */
  readonly identity: ResolvedIdentity;
  readonly store: StoragePort;
  readonly memberships: CanonicalMembershipReader;
}

export async function invokeReadCanonical(opts: CanonicalReadOpts): Promise<CanonicalReadServed> {
  assertCanonicalStore(opts.store, opts.operation);
  assertCanonicalMemberships(opts.memberships, opts.operation);
  const loaded = await loadCanonicalDescriptors(opts.asm, opts.artifact);
  const model = readModelForOperation(opts.operation);
  if (model !== null && loaded.ruledModels.has(model)) {
    throw ruledReadRefusal(loaded.producers.errors, model);
  }
  // Bound per call (never cached): the store + memberships are
  // request-scoped, while the registry + policy ride the artifact
  // cache. `createReadInvoker` is a trivial closure, so per-call
  // binding costs nothing and pins nothing across workers.
  const reader = loaded.producers.transact.createReadInvoker({
    registry: loaded.registry,
    policy: loaded.policy,
    store: opts.store,
    memberships: opts.memberships,
  });
  const served = await reader({
    envelope: { operation: opts.operation, inputs: opts.inputs },
    identity: opts.identity,
  });
  if (!Array.isArray(served.records)) {
    throw new Error(`t17b: invokeRead served no records array (invoke/dist skew?)`);
  }
  return served;
}
