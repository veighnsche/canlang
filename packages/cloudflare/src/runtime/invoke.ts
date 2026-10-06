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
 *
 * T24b (the section at the end, additive): worker dispatch execution —
 * the composed system registry (`[...l3Commands, ...WORK_SYSTEM_COMMANDS,
 * ...WORK_DISPATCH_STAGE_COMMANDS]`, composed worker-side by
 * `assembly.ts`) running over the dispatch-join port. Single-attempt
 * drives (claim -> claim-time guard re-eval -> provider call ->
 * record-attempt), run-key-honoring staging, and the recovery sweeper
 * (recover -> planRecoveryScan -> requeue/reconcile/release) live here.
 * State producers load dynamically (below); work producers (command
 * arrays, planner, classifier) arrive injected because `@canlang/work`
 * has no dist build. Provider calls, guard evaluation, evidence, and
 * snapshots are caller-supplied ports — BOUND provider sends are
 * explicitly OUT (T24a remainder): this wiring calls through the
 * injected ports only and never binds a send target itself.
 */
import type {
  ClaimId,
  CompileArtifact,
  DispatchClaim,
  InvocationContext,
  Membership,
  ModelName,
  MutationResult,
  OccurrenceId,
  OutboxId,
  OutboxIntent,
  OutboxItem,
  OutboxItemState,
  QuerySpec,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  RetryClass,
  RetryPolicy,
  Revision,
  CommitBatch,
  CommitResult,
  ProjectedRecord,
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
 * entries and receipts carry the admitted operation identity. T32b:
 * the checkpoint POINT (revision + owner only) rides beside it — the
 * runtime value is the state's full `AdmittedCall`, so the point is
 * present whenever canonical invoke admitted with a fence; the seam
 * forwards it as the pipeline `trigger` (hook transitive reads name
 * it back as their `triggerRevision`) and never reads its enrolled
 * dependencies (hooks inherit nothing).
 */
export interface CanonicalSeamCall {
  readonly context: InvocationContext;
  readonly def: unknown;
  readonly inputs: Record<string, unknown>;
  readonly checkpoint?: {
    readonly revision: Revision;
    readonly owner: string;
  };
}

/**
 * T32b: mirror of `GuardRevalidation`
 * (`packages/state/src/invocation/admission.ts`): one predicate the
 * fenced commit re-evaluates live against CURRENT state. The scenario
 * seam offers its caller-roles guard here; anything row-derived stays
 * uncovered by guards (the revision assertion already voids on any
 * intervening write).
 */
export interface CanonicalGuardRevalidation {
  readonly name: string;
  readonly evaluate: () => boolean | Promise<boolean>;
}

/**
 * Mirror of `ExecutionEffects`
 * (`packages/state/src/invocation/invoke.ts:47`): the provisional
 * outcome one execution pass stages for the fenced commit. T32b:
 * `guards`/`readings` flow into the state's commit-time revalidation
 * untouched (absent reads as none): guards re-run live (a flip voids
 * with `forbidden` naming the guard) and any eventual-marked reading
 * refuses with `validation`.
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
  readonly guards?: ReadonlyArray<CanonicalGuardRevalidation>;
  readonly readings?: ReadonlyArray<unknown>;
}

/**
 * T32b: the pipeline `trigger` point for one seam call — the
 * checkpoint's revision + owner, and nothing else. Exported for the
 * colocated forwarding proof (canonical descriptors carry no hooks,
 * so no hook body can observe the trigger through the real seam;
 * the unit pins the derivation and the stageWrite call site below
 * pins the pass-through by read).
 */
export function seamTriggerPoint(
  call: CanonicalSeamCall,
): { readonly revision: Revision; readonly owner: string } | undefined {
  const checkpoint: unknown = call.checkpoint;
  if (checkpoint === undefined) return undefined;
  if (!isUnknownRecord(checkpoint)) {
    throw new Error(`t32b: seam call checkpoint is not a record (invoke/dist skew?)`);
  }
  const revision: unknown = checkpoint["revision"];
  const owner: unknown = checkpoint["owner"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    throw new Error(`t32b: seam call checkpoint revision is not a valid revision (invoke/dist skew?)`);
  }
  if (typeof owner !== "string" || owner === "") {
    throw new Error(`t32b: seam call checkpoint owner is not a non-empty string (invoke/dist skew?)`);
  }
  return { revision: revision as Revision, owner };
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
    /**
     * T32b: the triggering checkpoint POINT (revision + owner). Hook
     * bodies read it as `transitive.triggerRevision`; the trigger's
     * enrolled dependencies never cross (the point carries none).
     */
    readonly trigger?: { readonly revision: Revision; readonly owner: string };
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
 * T32b: freeze one caller-roles observation into a comparable snapshot
 * (sorted, NUL-joined — order-free, collision-free on role names).
 */
function snapshotCallerRoles(grants: ReadonlyArray<string>): string {
  return [...grants].sort().join("\0");
}

/**
 * T32b: re-read the live caller-roles snapshot for the `caller.roles`
 * guard: the CURRENT active roles, or null when no active membership
 * backs the call. Never trusts the admitted identity's claims — the
 * reader is the live membership store.
 */
async function readCallerRolesSnapshot(
  memberships: CanonicalMembershipReader,
  teamId: string,
  actorUserId: string,
): Promise<string | null> {
  const membership = await memberships.findMembership(teamId, actorUserId);
  if (membership === null || membership.status !== "active") return null;
  return snapshotCallerRoles(membership.roles.map((grant) => grant.role));
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
  // T32b: the caller-roles snapshot behind `c.caller.roles` — the ONE
  // authorization-relevant fact the seam reads from NON-fenced state
  // (the membership store moves no state revision, so the revision
  // assertion cannot cover it; the mechanism's own `by`/revocation
  // re-check covers permission, but the handler may have branched on
  // these exact roles). Null when no active membership backed the
  // call, so a mid-flight activation voids as loudly as a removal.
  // Read ONCE with the grants above: one live read per pass.
  let callerRolesSnapshot: string | null = null;
  if (actorUserId !== null && teamId !== null) {
    const membership = await opts.memberships.findMembership(teamId, actorUserId);
    if (membership !== null && membership.status === "active") {
      grants = membership.roles.map((grant) => grant.role);
      callerRolesSnapshot = snapshotCallerRoles(grants);
    }
  }
  const seamGuards: CanonicalGuardRevalidation[] =
    actorUserId !== null && teamId !== null
      ? [
          {
            name: "caller.roles",
            evaluate: async () =>
              (await readCallerRolesSnapshot(opts.memberships, teamId, actorUserId)) ===
              callerRolesSnapshot,
          },
        ]
      : [];
  // T32b: the pipeline `trigger` point for this pass (absent on
  // checkpoint-less calls, which revalidate by expectedRevision only).
  const seamTrigger = seamTriggerPoint(call);
  // T32b: every served read is offered as authorization evidence for
  // the commit's eventual bar. The REAL served objects (never a
  // projection) so an eventual marker would survive to the bar; the
  // engine serves authoritative reads here, so the quiet path passes.
  const servedReadings: unknown[] = [];
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
          // T32b: the triggering checkpoint point — hook bodies name it
          // back as their `triggerRevision` when they open fresh
          // transitive scopes. Absent on checkpoint-less calls.
          ...(seamTrigger === undefined ? {} : { trigger: seamTrigger }),
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
        // T32b: offer the REAL served object as authorization evidence
        // (an eventual marker would survive to the commit bar).
        servedReadings.push(served);
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
    // T32b: the seam's commit-time evidence — the caller-roles guard
    // plus every served read. State invoke revalidates both against
    // CURRENT state before the fenced commit (both-site inheritance:
    // this return flows into `ExecutionEffects` on the success path,
    // and the rejected-receipt path revalidates the checkpoint alone).
    guards: seamGuards,
    readings: servedReadings,
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
      // T32b: BOTH paths inherit both-site commit revalidation through
      // state invoke: the runtime `call` is the full admitted call
      // (checkpoint included) and the returned effects carry the
      // seam's guards/readings — CRUD via the state executor, scenarios
      // via `runScenarioSeam` above.
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

/* ------------------------------------------------------------------ */
/* T24b dispatch execution (worker claim/recovery wiring).              */
/*                                                                      */
/* T24a built the engine side (work kernel commands, intent lifecycle,  */
/* state staging, the dispatch-join port); this section wires           */
/* EXECUTION at the worker: the composed system registry running over   */
/* the join port. Single-attempt drives run claim -> claim-time guard   */
/* re-eval -> provider call -> record-attempt; staging honors the       */
/* run-key contract by construction; the recovery sweeper runs          */
/* recover -> planRecoveryScan -> requeue/reconcile/release.            */
/*                                                                      */
/* LOADING: state producers (`createSystemRegistry`, the three L3       */
/* commands, `createDispatchJoinPort`) load dynamically from state      */
/* dist (same P-B seam as the canonical producers above). Work          */
/* producers (command arrays, `planRecoveryScan`, `classifyFailure`)    */
/* arrive INJECTED — `@canlang/work` has no dist build, so there is     */
/* nothing to import; the deploy join supplies the real producers       */
/* exactly as tests supply them from work sources. Provider calls,      */
/* guard evaluation, reconcile evidence, and state snapshots are        */
/* caller-supplied ports. BOUND provider sends are explicitly OUT       */
/* (T24a remainder): this wiring calls through the injected             */
/* `callProvider` port only and never binds a send target itself        */
/* (the stdlib `send`/`emit` stubs stay stubs; B8 Handbook sends stay   */
/* E3019-refused compiler-side).                                        */
/*                                                                      */
/* FENCING (unchanged from T24a): every registry run commits            */
/* single-shot through the join-wrapped store (linkage-asserted, fence  */
/* conflicts surface as retryable `busy`, NO retry — callers decide);   */
/* reconcile batches commit update + outbox-ack atomically through      */
/* `commitJoin`. The claim fence itself is untouched: concurrent        */
/* claimants still serialize and exactly one wins. Cross-store          */
/* atomicity is NOT claimed (single-owner scope only — stated, never    */
/* inferred). T34 fanout lineage rides carried-only through staging     */
/* inputs and is never interpreted here.                                */
/* ------------------------------------------------------------------ */

/** T24b: state system-registry module (L3 commands + registry factory). */
const STATE_SYSTEM_SPECIFIER = "../../../state/dist/state/src/ports/system.js";

/** T32b: state admission module (`openTransitiveScope` for dispatch fences). */
const STATE_ADMISSION_SPECIFIER = "../../../state/dist/state/src/invocation/admission.js";

/**
 * T24b: one composable system command as it flows through the worker
 * seam. Structural: only `name` is read here (assembly order + unique
 * checks); the real def (with its `stage`) rides opaquely into
 * `createSystemRegistry`, which validates it at runtime.
 */
export interface DispatchWorkerCommand {
  readonly name: string;
}

/** T24b: structural view of the L3 command registry (`SystemRegistry`). */
export interface DispatchSystemRegistry {
  run(
    name: string,
    args: unknown,
    ctx: DispatchSystemRunContext,
    deps: { readonly store: StoragePort },
  ): Promise<DispatchSystemRunResult>;
}

/** T24b: structural view of `SystemRunContext` (operator-run identity). */
export interface DispatchSystemRunContext {
  readonly actor: string;
  readonly now: number;
  readonly operation: string;
  readonly operationId: string;
}

/** T24b: structural view of `SystemRunResult` (fence revision + result). */
export interface DispatchSystemRunResult {
  readonly revision: Revision;
  readonly result: unknown;
}

/** T24b: structural view of the dispatch-join port (`DispatchJoinPort`). */
export interface DispatchJoinPort {
  commitJoin(batch: CommitBatch): Promise<CommitResult>;
}

/** T24b: structural view of the state system module (T24a join surface). */
interface StateSystemProducer {
  createSystemRegistry(commands: ReadonlyArray<unknown>): DispatchSystemRegistry;
  outboxAckCommand: unknown;
  scheduleCancelCommand: unknown;
  scheduleReplaceCommand: unknown;
}

/** T24b: structural view of the state join-port factory. */
interface StateJoinProducer {
  createDispatchJoinPort(input: { readonly store: StoragePort }): DispatchJoinPort;
}

/** T24b: loaded dispatch-system producers (fail loud, never partial). */
export interface DispatchSystemProducers {
  readonly createSystemRegistry: (
    commands: ReadonlyArray<unknown>,
  ) => DispatchSystemRegistry;
  /** L3 segment in registry order: ack, schedule cancel, schedule replace. */
  readonly l3Commands: ReadonlyArray<DispatchWorkerCommand>;
  readonly createDispatchJoinPort: (input: {
    readonly store: StoragePort;
  }) => DispatchJoinPort;
}

function asWorkerCommand(value: unknown, binding: string): DispatchWorkerCommand {
  if (!isUnknownRecord(value) || typeof value["name"] !== "string" || value["name"] === "") {
    throw new Error(
      `t24b: state system producer binding ${JSON.stringify(binding)} is not a named command (stale dist?)`,
    );
  }
  return value as unknown as DispatchWorkerCommand;
}

/**
 * T24b: load the state dispatch-system producers (registry factory, the
 * three L3 commands, join-port factory). Dynamic dist imports through
 * the P-B seam, shape-checked fail-loud like the canonical producers.
 */
export async function loadDispatchSystemProducers(): Promise<DispatchSystemProducers> {
  const systemMod = await loadProducerModule(STATE_SYSTEM_SPECIFIER, "state system producer");
  const joinMod = await loadProducerModule(STATE_TRANSACT_SPECIFIER, "state dispatch-join producer");
  const createSystemRegistry = requireProducerFn(
    systemMod,
    "createSystemRegistry",
    "state system producer",
  );
  const createDispatchJoinPort = requireProducerFn(
    joinMod,
    "createDispatchJoinPort",
    "state dispatch-join producer",
  );
  return {
    createSystemRegistry:
      createSystemRegistry as StateSystemProducer["createSystemRegistry"],
    l3Commands: [
      asWorkerCommand(systemMod["outboxAckCommand"], "outboxAckCommand"),
      asWorkerCommand(systemMod["scheduleCancelCommand"], "scheduleCancelCommand"),
      asWorkerCommand(systemMod["scheduleReplaceCommand"], "scheduleReplaceCommand"),
    ],
    createDispatchJoinPort:
      createDispatchJoinPort as StateJoinProducer["createDispatchJoinPort"],
  };
}

/**
 * T24b: build the worker dispatch registry over an ALREADY-composed
 * command array. Composition stays single-homed in `assembly.ts`
 * (`assembleDispatchCommands`); this factory only loads the L3
 * `createSystemRegistry` producer and constructs. Callers run every
 * command over a dispatch-join-wrapped store (below).
 */
export async function createWorkerDispatchRegistry(
  composed: ReadonlyArray<DispatchWorkerCommand>,
): Promise<DispatchSystemRegistry> {
  const producers = await loadDispatchSystemProducers();
  return producers.createSystemRegistry(composed);
}

/** T24b: bind the dispatch-join port over one store (single-shot fenced commits). */
export async function createWorkerDispatchJoinPort(
  store: StoragePort,
): Promise<DispatchJoinPort> {
  const producers = await loadDispatchSystemProducers();
  return producers.createDispatchJoinPort({ store });
}

/**
 * T24b: route every fenced commit through the dispatch-join port
 * (linkage-asserted, single-shot; fence conflicts surface as retryable
 * `busy`). All non-commit port methods delegate untouched. Registry
 * runs over this store execute claim/record/requeue/recover/stage with
 * the join assertion on every batch — updates-only batches pass
 * trivially, so lifecycle commands are unaffected while staging joins
 * stay atomic. Delegation list mirrors the commit guard; tsc enforces
 * the return type.
 */
export function withDispatchJoinPort(store: StoragePort, port: DispatchJoinPort): StoragePort {
  return {
    readRevision: () => store.readRevision(),
    load: (model, id) => store.load(model, id),
    query: (spec) => store.query(spec),
    commit: (batch) => port.commitJoin(batch),
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

/**
 * T32b: structural view of the state admission module's transitive
 * scope opener (`openTransitiveScope` in
 * `state/src/invocation/admission.ts`). Only `snapshot()` is read
 * here (the revision + owner point naming the dispatch's own fresh
 * checkpoint); enrollment stays engine-internal.
 */
export interface StateFenceAdmissionProducer {
  openTransitiveScope(
    store: Pick<StoragePort, "readRevision">,
    owner: string,
  ): Promise<{
    snapshot(): { readonly revision: Revision; readonly owner: string };
  }>;
}

/**
 * T32b: load the fence admission producer (dynamic dist import
 * through the P-B seam, shape-checked fail-loud like the other
 * producers).
 */
export async function loadFenceAdmissionProducer(): Promise<StateFenceAdmissionProducer> {
  const admissionMod = await loadProducerModule(STATE_ADMISSION_SPECIFIER, "state fence producer");
  const openTransitiveScope = requireProducerFn(
    admissionMod,
    "openTransitiveScope",
    "state fence producer",
  );
  return {
    openTransitiveScope:
      openTransitiveScope as StateFenceAdmissionProducer["openTransitiveScope"],
  };
}

/**
 * T32b: structural mirror of work's `attemptDispatch` decision
 * function (`work/src/dispatch/index.ts`) — the injected pure kernel
 * the fenced drive consults. Only the fields the kernel reads are
 * typed; everything else rides structurally. Like `classifyFailure`,
 * the REAL work function arrives injected (there is no work dist to
 * import); the deploy join supplies it exactly as tests supply it
 * from work sources.
 */
export type FenceAttemptDispatchFn = (
  deps: {
    readonly clock: { nowMs(): number };
    readonly claimIds: { nextClaimId(): string };
    readonly supersessions: { isSuperseded(outboxId: string): boolean };
    readonly evaluateGuard: (
      predicate: string,
      frozenInputs: unknown,
      stateSnapshot: unknown,
    ) => unknown;
  },
  attempt: {
    readonly intent: {
      readonly item: {
        readonly id: string;
        readonly operationId: string;
        readonly source: string;
        readonly occurrenceIndex: number;
        readonly request: Readonly<Record<string, unknown>>;
        readonly originOccurrence: null;
        readonly state: "pending";
      };
      readonly commit: { readonly revision: number; readonly committedAtMs: number };
    };
    readonly guard: { readonly predicate: string | null };
    readonly frozenInputs: unknown;
    readonly stateSnapshot: unknown;
    readonly fence: {
      readonly checkpoint: { readonly revision: number; readonly owner: string };
      readonly triggerRevision?: { readonly revision: number };
      readonly revalidateAuthority: () => boolean;
    };
  },
) => unknown;

/** T32b: the fence point echoed on every refused drive outcome. */
export interface DriveDispatchFenceEcho {
  readonly checkpoint: { readonly revision: number; readonly owner: string };
  readonly triggerRevision: { readonly revision: number } | null;
}

/**
 * T32b: the claim-time fence gate for one dispatch drive. Absent
 * (the default) keeps the EXACT pre-T32b behavior — no kernel call,
 * no authority re-read. Present, the drive opens its OWN fresh
 * checkpoint via `openTransitiveScope` (never the triggering read's
 * snapshot) and consults the REAL injected `attemptDispatch` with the
 * committed guard ordering (inherited-scope -> supersession ->
 * guard -> revocation -> claim):
 *
 * - `owner` names the checkpoint owner (the trigger owner for
 *   transitive dispatches, else the owning scope).
 * - `triggerRevision` names the triggering checkpoint's revision for
 *   transitive dispatches; presenting it back as the checkpoint is
 *   inheriting and is refused. ABSENT means a direct dispatch with
 *   no trigger snapshot to inherit (intents carry no trigger point
 *   yet — the hook-to-dispatch trigger flow is unwired).
 * - `revalidateAuthority` re-reads LIVE authority at fence time (the
 *   drive awaits it; the pure-sync kernel replays the resolved
 *   verdict). A revocation landing between trigger and drive denies
 *   the transitive effect — no cached snapshot authorizes a spend.
 */
export interface DriveDispatchFenceInput {
  readonly owner: string;
  readonly triggerRevision?: { readonly revision: number };
  readonly revalidateAuthority: () => boolean | Promise<boolean>;
  readonly attemptDispatch: FenceAttemptDispatchFn;
}

/** T32b: one kernel verdict the fenced drive handles. */
type FenceAttemptVerdict =
  | { readonly status: "claimed"; readonly claim: { readonly outboxId: string; readonly claimId: string; readonly claimedAt: number } }
  | { readonly status: "skipped" }
  | { readonly status: "refused-inherited-scope" }
  | { readonly status: "refused-revoked" };

/**
 * T32b: fail-closed read of the injected kernel's verdict. `claimed`
 * carries the held claim back (shape-checked; the drive asserts it
 * equals the held claim); `skipped` runs the existing skip ceremony;
 * the two refused statuses return. Every other status is unreachable
 * by construction — the drive attests a committed pending intent
 * (the claim run just proved pending + non-superseded) — so anything
 * else (superseded/refused-state/refused-uncommitted/unknown) is a
 * loud wiring error, never a silent drive.
 */
function checkFenceAttemptVerdict(value: unknown): FenceAttemptVerdict {
  if (!isUnknownRecord(value) || typeof value["status"] !== "string") {
    throw new Error(`t32b: fence kernel verdict must carry a string status (producer skew?)`);
  }
  const status: string = value["status"];
  if (status === "skipped") return { status };
  if (status === "refused-inherited-scope") return { status };
  if (status === "refused-revoked") return { status };
  if (status === "claimed") {
    const claim: unknown = value["claim"];
    if (!isUnknownRecord(claim)) {
      throw new Error(`t32b: fence kernel claimed verdict lost its claim (producer skew?)`);
    }
    const outboxId: unknown = claim["outboxId"];
    const claimId: unknown = claim["claimId"];
    const claimedAt: unknown = claim["claimedAt"];
    if (typeof outboxId !== "string" || typeof claimId !== "string" || typeof claimedAt !== "number") {
      throw new Error(`t32b: fence kernel claim is misshapen (producer skew?)`);
    }
    return { status, claim: { outboxId, claimId, claimedAt } };
  }
  throw new Error(
    `t32b: fence kernel verdict ${JSON.stringify(status)} is unreachable here ` +
      `(the drive attests a committed pending intent over a won claim) — refusing to drive on it`,
  );
}

/**
 * T24b structural mirror of the lane-04 dispatch table model
 * (`@canlang/work` `WORK_DISPATCH_MODEL`, `runtime/executors.ts`
 * `WORK_DISPATCH_MODEL`, state `DISPATCH_JOIN_MODEL`). Drift is pinned
 * by the execution tests (all four literals asserted equal), not by a
 * shared import.
 */
const T24B_WORK_DISPATCH_MODEL = "work.dispatch" as ModelName;

/**
 * T24b structural mirror of the lane-04 dispatch row
 * (`DispatchRowData` in `work/src/kernel/tables.ts`). The sweeper reads
 * rows through `readDispatchExecutionRow` (below), which enforces the
 * same accept sets — drift fails loud at read, and the execution
 * tests cross-check this reader against the real `readDispatchRow`.
 */
export interface DispatchExecutionRowData {
  readonly intentId: string;
  readonly operationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  readonly originOccurrence: string | null;
  readonly state: OutboxItemState;
  readonly attempts: number;
  readonly claimId: string | null;
  readonly claimedAtMs: number | null;
  readonly guardVerdict: boolean | null;
  readonly deliveryId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly availableAtMs: number | null;
  readonly firstAttemptAtMs: number | null;
  readonly retryClass: RetryClass | null;
}

const T24B_DISPATCH_STATES: ReadonlySet<string> = new Set([
  "pending",
  "claimed",
  "delivered",
  "failed",
  "uncertain",
  "dead",
]);

function dispatchRowString(
  data: Record<string, unknown>,
  field: string,
): string {
  const value: unknown = data[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`t24b: work.dispatch.${field} must be a non-empty string.`);
  }
  return value;
}

function dispatchRowNullableString(
  data: Record<string, unknown>,
  field: string,
): string | null {
  const value: unknown = data[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`t24b: work.dispatch.${field} must be a string or null.`);
  }
  return value;
}

function dispatchRowCount(data: Record<string, unknown>, field: string): number {
  const value: unknown = data[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`t24b: work.dispatch.${field} must be an integer >= 0.`);
  }
  return value;
}

function dispatchRowNullableInstant(
  data: Record<string, unknown>,
  field: string,
): number | null {
  const value: unknown = data[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`t24b: work.dispatch.${field} must be finite epoch ms >= 0 or null.`);
  }
  return value;
}

/**
 * T24b: fail-closed structural read of one dispatch row (mirrors
 * `readDispatchRow` accept sets: six lifecycle states, nullable
 * claim/guard/error/deferral/classification fields). Unknown states,
 * malformed fields, and non-object data throw — the sweeper never
 * decides on a row it cannot parse.
 */
export function readDispatchExecutionRow(row: StoredRow): DispatchExecutionRowData {
  const data: unknown = row.data;
  if (!isUnknownRecord(data)) {
    throw new Error("t24b: work.dispatch data must be an object.");
  }
  const state = dispatchRowString(data, "state");
  if (!T24B_DISPATCH_STATES.has(state)) {
    throw new Error(`t24b: work.dispatch.state is unknown: ${JSON.stringify(state)}.`);
  }
  const guardVerdict: unknown = data["guardVerdict"];
  if (guardVerdict !== null && typeof guardVerdict !== "boolean") {
    throw new Error("t24b: work.dispatch.guardVerdict must be boolean or null.");
  }
  const retryClass: unknown = data["retryClass"];
  if (retryClass !== null && retryClass !== "transient" && retryClass !== "terminal") {
    throw new Error("t24b: work.dispatch.retryClass must be transient, terminal or null.");
  }
  return {
    intentId: dispatchRowString(data, "intentId"),
    operationId: dispatchRowString(data, "operationId"),
    source: dispatchRowString(data, "source"),
    occurrenceIndex: dispatchRowCount(data, "occurrenceIndex"),
    originOccurrence: dispatchRowNullableString(data, "originOccurrence"),
    state: state as OutboxItemState,
    attempts: dispatchRowCount(data, "attempts"),
    claimId: dispatchRowNullableString(data, "claimId"),
    claimedAtMs: dispatchRowNullableInstant(data, "claimedAtMs"),
    guardVerdict,
    deliveryId: dispatchRowNullableString(data, "deliveryId"),
    errorCode: dispatchRowNullableString(data, "errorCode"),
    errorMessage: dispatchRowNullableString(data, "errorMessage"),
    availableAtMs: dispatchRowNullableInstant(data, "availableAtMs"),
    firstAttemptAtMs: dispatchRowNullableInstant(data, "firstAttemptAtMs"),
    retryClass,
  };
}

/**
 * T24b: dispatch rows in one lifecycle state. Structural mirror of
 * `dispatchByStateQuery` (`work/src/kernel/tables.ts`): flat `state`
 * equality, `owner` authority (the store ignores authority; commands
 * pass `owner` for the privileged path). The sweeper re-filters every
 * result exactly — predicates only narrow scans.
 */
export function dispatchExecutionByStateQuery(state: OutboxItemState): QuerySpec {
  return {
    model: T24B_WORK_DISPATCH_MODEL,
    where: { op: "eq", field: "state", value: state },
    authority: "owner",
  };
}

/**
 * T24b mirror of the work `FailureCause` vocabulary
 * (`work/src/receipt/index.ts`): the injected provider's closed
 * failure shapes. Adapters supply already-closed codes/messages; the
 * driver never invents error details.
 */
export type DispatchFailureCause =
  | { readonly kind: "handler-require-false"; readonly require: string }
  | { readonly kind: "permanent"; readonly code: string; readonly message: string }
  | { readonly kind: "transient"; readonly code: string; readonly message: string };

/**
 * T24b mirror of the work `ProviderOutcome`
 * (`work/src/receipt/index.ts`): definitive-or-ambiguous outcome of
 * one provider-call attempt.
 */
export type DispatchProviderOutcome =
  | { readonly kind: "delivered"; readonly result: unknown }
  | { readonly kind: "failed"; readonly cause: DispatchFailureCause }
  | { readonly kind: "uncertain" };

/**
 * T24b mirror of the work `ReconcileEvidence`
 * (`work/src/receipt/index.ts`): proof of what the provider did for an
 * uncertain row. `not-found` proves the provider never saw the attempt.
 */
export type DispatchReconcileEvidence =
  | { readonly kind: "delivered"; readonly result: unknown }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | { readonly kind: "not-found" };

/**
 * T24b mirror of the work `GuardEvaluator`
 * (`work/src/dispatch/index.ts`): injected pure guard evaluator —
 * predicate reference plus frozen inputs plus a CURRENT owner-state
 * snapshot produce a boolean verdict. Total, deterministic,
 * side-effect free; unresolvable predicates throw or return false.
 */
export type DispatchGuardEvaluator = (
  predicate: string,
  frozenInputs: unknown,
  stateSnapshot: unknown,
) => boolean;

/**
 * T24b: injected provider-call port. The driver calls exactly one
 * provider attempt per won claim. BOUND sends are OUT (T24a
 * remainder): this port is supplied by the caller (deploy join or
 * test double) — the driver never resolves a send target itself.
 */
export type DispatchProviderCaller = (
  intent: OutboxIntent,
  claim: DispatchClaim,
) => Promise<DispatchProviderOutcome>;

/**
 * T24b: injected reconcile-evidence reader (provider-evidence
 * plumbing). Returns decisive evidence for an uncertain row, or null
 * when unknown — unknown stays unknown and the row is untouched.
 */
export type DispatchEvidenceReader = (
  intentId: string,
) => DispatchReconcileEvidence | null;

/**
 * T24b: injected current-state snapshot reader for claim-time guard
 * re-evaluation. The driver pulls the snapshot AFTER winning the
 * claim, so re-eval observes current owner state — never the
 * stage-time snapshot (which is recorded history).
 */
export type DispatchSnapshotReader = (intent: OutboxIntent) => unknown;

/**
 * T24b: injected failure classifier (the real work `classifyFailure`).
 * Transient retries the same occurrence; anything else is terminal.
 */
export type DispatchFailureClassifier = (cause: DispatchFailureCause) => RetryClass;

/**
 * T24b mirror of the work `RecoverableRow`
 * (`work/src/recovery/index.ts`): one row entering the recovery scan.
 * The sweeper assembles views from stored dispatch rows; `request` is
 * always `{}` — the planner reads id/state/attempts only, and the
 * frozen provider inputs live on the L3 intent, not the dispatch row.
 */
export interface DispatchRecoverableRow {
  readonly item: OutboxItem;
  readonly guardVerdict: boolean | null;
  readonly firstAttemptAtMs: number | null;
  readonly retryClass: RetryClass | null;
}

/**
 * T24b mirror of the work `RecoveryPlan`
 * (`work/src/recovery/index.ts`): every actionable row in exactly one
 * list; rows needing no action appear in none.
 */
export interface DispatchRecoveryPlan {
  readonly resume: ReadonlyArray<string>;
  readonly retry: ReadonlyArray<string>;
  readonly reconcile: ReadonlyArray<string>;
  readonly awaiting: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly terminal: ReadonlyArray<string>;
  readonly dead: ReadonlyArray<string>;
}

/**
 * T24b: injected recovery planner (the real work
 * `planRecoveryScan`). The sweeper executes its decision table; the
 * planner itself stays engine-owned and is never reimplemented here.
 */
export type DispatchRecoveryPlanner = (input: {
  readonly rows: ReadonlyArray<DispatchRecoverableRow>;
  readonly claims: ReadonlyArray<DispatchClaim>;
  readonly evidence: (id: string) => DispatchReconcileEvidence | null;
  readonly nowMs: number;
  readonly maxClaimAgeMs: number;
  readonly policy: RetryPolicy;
}) => DispatchRecoveryPlan;

function checkClosedText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`t24b: ${what} must be a non-empty string.`);
  }
  return value;
}

/**
 * T24b: fail-closed read of one injected provider outcome. Malformed
 * outcomes (unknown kinds, incoherent causes, empty closed codes)
 * throw INSIDE the driver's provider boundary and record `uncertain`
 * — an adapter that answers incoherently may still have acted, so
 * unknown stays unknown instead of retrying blind.
 */
function checkProviderOutcome(value: unknown): DispatchProviderOutcome {
  if (!isUnknownRecord(value)) {
    throw new Error("t24b: provider outcome must be an object.");
  }
  const kind: unknown = value["kind"];
  if (kind === "delivered") {
    return { kind: "delivered", result: value["result"] };
  }
  if (kind === "uncertain") {
    return { kind: "uncertain" };
  }
  if (kind !== "failed") {
    throw new Error(
      `t24b: provider outcome kind must be delivered, failed or uncertain (got ${JSON.stringify(kind)}).`,
    );
  }
  const cause: unknown = value["cause"];
  if (!isUnknownRecord(cause)) {
    throw new Error("t24b: failed provider outcomes need a cause object.");
  }
  const causeKind: unknown = cause["kind"];
  if (causeKind === "handler-require-false") {
    return {
      kind: "failed",
      cause: {
        kind: "handler-require-false",
        require: checkClosedText(cause["require"], "failure cause require"),
      },
    };
  }
  if (causeKind === "permanent" || causeKind === "transient") {
    return {
      kind: "failed",
      cause: {
        kind: causeKind,
        code: checkClosedText(cause["code"], "failure cause code"),
        message: checkClosedText(cause["message"], "failure cause message"),
      },
    };
  }
  throw new Error(
    `t24b: failure cause kind must be handler-require-false, permanent or transient (got ${JSON.stringify(causeKind)}).`,
  );
}

/**
 * T24b: fail-closed read of one reconcile-evidence answer. Decisive
 * shapes pass through; null stays null (unknown); anything else
 * throws — evidence that cannot be parsed cannot reconcile.
 */
function checkEvidenceAnswer(value: unknown, intentId: string): DispatchReconcileEvidence | null {
  if (value === null) return null;
  const where = `t24b: reconcile evidence for ${JSON.stringify(intentId)}`;
  if (!isUnknownRecord(value)) {
    throw new Error(`${where} must be an object or null.`);
  }
  const kind: unknown = value["kind"];
  if (kind === "delivered") {
    return { kind: "delivered", result: value["result"] };
  }
  if (kind === "not-found") {
    return { kind: "not-found" };
  }
  if (kind !== "failed") {
    throw new Error(`${where} has an unknown kind ${JSON.stringify(kind)}.`);
  }
  const code: unknown = value["code"];
  const message: unknown = value["message"];
  if (typeof code !== "string" || code === "" || typeof message !== "string" || message === "") {
    throw new Error(`${where} failed evidence needs a non-empty code and message.`);
  }
  return { kind: "failed", code, message };
}

/**
 * T24b: closed error for one classified failure cause. Mirrors the
 * engine `closedErrorForCause` (`work/src/receipt/index.ts`,
 * private there): a false authored `require` maps to the fixed
 * `require-false` pair; adapter causes carry their closed codes.
 */
function closedDispatchErrorForCause(cause: DispatchFailureCause): {
  readonly code: string;
  readonly message: string;
} {
  if (cause.kind === "handler-require-false") {
    return { code: "require-false", message: "handler requirement rejected the occurrence" };
  }
  return { code: cause.code, message: cause.message };
}

/* -- T24b command-result checks (fail-closed on engine/dist skew). -- */

interface DispatchClaimCheck {
  readonly claimed: boolean;
  readonly reason: string | null;
  readonly claimId: string | null;
}

function checkClaimResult(value: unknown): DispatchClaimCheck {
  if (!isUnknownRecord(value)) {
    throw new Error("t24b: claim result must be an object (command/dist skew?).");
  }
  const claimed: unknown = value["claimed"];
  if (typeof claimed !== "boolean") {
    throw new Error("t24b: claim result needs a boolean claimed (command/dist skew?).");
  }
  if (!claimed) {
    const reason: unknown = value["reason"];
    if (typeof reason !== "string" || reason === "") {
      throw new Error("t24b: refused claims need a non-empty reason (command/dist skew?).");
    }
    return { claimed: false, reason, claimId: null };
  }
  const claimId: unknown = value["claimId"];
  if (typeof claimId !== "string" || claimId === "") {
    throw new Error("t24b: won claims need a non-empty claimId (command/dist skew?).");
  }
  return { claimed: true, reason: null, claimId };
}

interface DispatchRecordCheck {
  readonly state: string;
  readonly attempts: number;
}

function checkRecordResult(value: unknown): DispatchRecordCheck {
  if (!isUnknownRecord(value)) {
    throw new Error("t24b: record result must be an object (command/dist skew?).");
  }
  if (value["recorded"] !== true) {
    throw new Error("t24b: record result needs recorded true (command/dist skew?).");
  }
  const state: unknown = value["state"];
  if (typeof state !== "string" || state === "") {
    throw new Error("t24b: record result needs a non-empty state (command/dist skew?).");
  }
  const attempts: unknown = value["attempts"];
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) {
    throw new Error("t24b: record result needs attempts as an integer >= 0 (command/dist skew?).");
  }
  return { state, attempts };
}

interface DispatchRequeueCheck {
  readonly requeued: boolean;
  readonly dead: boolean;
  readonly reason: string | null;
}

function checkRequeueResult(value: unknown): DispatchRequeueCheck {
  if (!isUnknownRecord(value)) {
    throw new Error("t24b: requeue result must be an object (command/dist skew?).");
  }
  const requeued: unknown = value["requeued"];
  const dead: unknown = value["dead"];
  if (typeof requeued !== "boolean" || typeof dead !== "boolean") {
    throw new Error("t24b: requeue result needs boolean requeued/dead (command/dist skew?).");
  }
  const reason: unknown = value["reason"];
  if (reason !== undefined && (typeof reason !== "string" || reason === "")) {
    throw new Error("t24b: requeue reason must be a non-empty string (command/dist skew?).");
  }
  return { requeued, dead, reason: reason ?? null };
}

interface DispatchRecoverCheck {
  readonly released: ReadonlyArray<string>;
  readonly resumeAfter: string | null;
  readonly done: boolean;
  readonly uncertain: ReadonlyArray<string>;
  readonly uncertainTruncated: boolean;
}

function checkStringList(value: unknown, what: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`t24b: ${what} must be an array of strings (command/dist skew?).`);
  }
  return [...value];
}

function checkRecoverResult(value: unknown): DispatchRecoverCheck {
  if (!isUnknownRecord(value)) {
    throw new Error("t24b: recover result must be an object (command/dist skew?).");
  }
  const resumeAfter: unknown = value["resumeAfter"];
  if (resumeAfter !== null && (typeof resumeAfter !== "string" || resumeAfter === "")) {
    throw new Error("t24b: recover resumeAfter must be a non-empty string or null (command/dist skew?).");
  }
  const done: unknown = value["done"];
  if (typeof done !== "boolean") {
    throw new Error("t24b: recover result needs a boolean done (command/dist skew?).");
  }
  const uncertainTruncated: unknown = value["uncertainTruncated"];
  if (typeof uncertainTruncated !== "boolean") {
    throw new Error("t24b: recover result needs a boolean uncertainTruncated (command/dist skew?).");
  }
  return {
    released: checkStringList(value["released"], "recover released"),
    resumeAfter,
    done,
    uncertain: checkStringList(value["uncertain"], "recover uncertain"),
    uncertainTruncated,
  };
}

function checkReleaseResult(value: unknown): { readonly released: boolean } {
  if (!isUnknownRecord(value)) {
    throw new Error("t24b: release result must be an object (command/dist skew?).");
  }
  const released: unknown = value["released"];
  if (typeof released !== "boolean") {
    throw new Error("t24b: release result needs a boolean released (command/dist skew?).");
  }
  return { released };
}

/* -- T24b run-key-honoring staging. -- */

/**
 * T24b: T33-carried fanout lineage on one staging input. Carried-only
 * (never interpreted — the T34 fanout rule is not adopted): echoed to
 * the stage command untouched, which validates its shape.
 */
export interface DispatchStageFanout {
  readonly cohortId: string;
  readonly parentOccurrence: string;
  readonly childIndex: number;
  readonly checkpointId: string | null;
}

/** T24b: one intent entering run-key-honoring staging. */
export interface DispatchStageIntentInput {
  readonly intentId: string;
  readonly operation: string;
  readonly originOperationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  readonly request: Record<string, unknown>;
  readonly originOccurrence: string | null;
  readonly guard: string | null;
  readonly guardVerdict: boolean | null;
  readonly fanout?: DispatchStageFanout | null;
}

/** T24b: run-key-honoring staging options. */
export interface StageDispatchBatchOpts {
  readonly registry: DispatchSystemRegistry;
  /** Join-wrapped store: the join commits linkage-asserted. */
  readonly store: StoragePort;
  readonly actor: string;
  readonly now: number;
  readonly operation: string;
  /**
   * THE run key: passed as BOTH the run operationId AND stage
   * args.operationId — the run-key contract by construction (a
   * mismatch is unrepresentable here; the registry rejects direct
   * mismatched runs fail-closed, pinned by the execution tests).
   */
  readonly runKey: string;
  readonly intents: ReadonlyArray<DispatchStageIntentInput>;
}

/** T24b: run-key-honoring staging outcome. */
export interface StageDispatchBatchResult {
  readonly revision: Revision;
  readonly staged: ReadonlyArray<unknown>;
  readonly skipped: ReadonlyArray<unknown>;
  readonly replayed: ReadonlyArray<string>;
}

/**
 * T24b: stage one dispatch batch through `work.dispatch.stage` with
 * the run-key contract honored by construction (one key in both
 * places). One fenced revision carries each intent's dispatch row plus
 * its L3 outbox intent; guard-false intents stage a pinned skip row
 * with no outbox half. A trigger rollback voids the whole join.
 */
export async function stageDispatchBatch(
  opts: StageDispatchBatchOpts,
): Promise<StageDispatchBatchResult> {
  if (typeof opts.runKey !== "string" || opts.runKey === "") {
    throw new Error("t24b: staging needs a non-empty run key.");
  }
  const run = await opts.registry.run(
    "work.dispatch.stage",
    {
      operationId: opts.runKey,
      intents: opts.intents.map((intent) => ({
        intentId: intent.intentId,
        operation: intent.operation,
        originOperationId: intent.originOperationId,
        source: intent.source,
        occurrenceIndex: intent.occurrenceIndex,
        request: intent.request,
        originOccurrence: intent.originOccurrence,
        guard: intent.guard,
        guardVerdict: intent.guardVerdict,
        ...(intent.fanout === undefined || intent.fanout === null
          ? {}
          : { fanout: intent.fanout }),
      })),
    },
    { actor: opts.actor, now: opts.now, operation: opts.operation, operationId: opts.runKey },
    { store: opts.store },
  );
  if (!isUnknownRecord(run.result)) {
    throw new Error("t24b: stage result must be an object (command/dist skew?).");
  }
  const staged: unknown = run.result["staged"];
  const skipped: unknown = run.result["skipped"];
  if (!Array.isArray(staged) || !Array.isArray(skipped)) {
    throw new Error("t24b: stage result needs staged/skipped arrays (command/dist skew?).");
  }
  return {
    revision: run.revision,
    staged: [...staged],
    skipped: [...skipped],
    replayed: checkStringList(run.result["replayed"], "stage replayed"),
  };
}

/* -- T24b single-attempt drive (claim -> guard -> provider -> record). -- */

/** T24b: single-attempt drive options. */
export interface DriveDispatchIntentOpts {
  readonly registry: DispatchSystemRegistry;
  /** Join-wrapped store: claim/record batches commit linkage-asserted. */
  readonly store: StoragePort;
  /** L3 intent under drive (carries `dispatchGuard` + frozen `arguments`). */
  readonly intent: OutboxIntent;
  readonly actor: string;
  readonly operation: string;
  readonly nowMs: () => number;
  /** Injected claim-id mint (`ClaimIdPort`); must be non-empty. */
  readonly nextClaimId: () => string;
  readonly maxClaimAgeMs: number;
  /** Run operationId for the claim run (non-empty; the registry re-validates). */
  readonly claimOperationId: string;
  /** Run operationId for the record run. */
  readonly recordOperationId: string;
  /** Injected claim-time guard evaluator (re-eval, not the stage pin). */
  readonly evaluateGuard: DispatchGuardEvaluator;
  /** Injected current-state snapshot reader (pulled after the claim wins). */
  readonly readStateSnapshot: DispatchSnapshotReader;
  /** Injected provider-call port (BOUND sends are OUT — caller supplies). */
  readonly callProvider: DispatchProviderCaller;
  /** Injected failure classifier (the real work `classifyFailure`). */
  readonly classifyFailure: DispatchFailureClassifier;
  /**
   * T32b: the claim-time fence gate (absent keeps the EXACT pre-T32b
   * behavior — no kernel call, no authority re-read). Present, the
   * drive opens its own fresh checkpoint and consults the REAL
   * injected `attemptDispatch` after the claim wins (guard re-eval
   * moves INSIDE the kernel call, so the committed ordering holds
   * exactly: inherited-scope -> supersession -> guard -> revocation
   * -> claim). Refused verdicts return WITHOUT a provider call, a
   * record, or an ack: the held claim ages out and the sweeper
   * re-drives (re-fencing from scratch).
   */
  readonly fence?: DriveDispatchFenceInput;
}

/** T24b: single-attempt drive outcome. */
export type DriveDispatchOutcome =
  /** No claim won (superseded, guard-false, deferred, held, settled): no provider call, no record. */
  | { readonly status: "not-claimed"; readonly intentId: string; readonly reason: string }
  /** Claim-time guard re-eval was false: skip recorded (attempts untouched), L3 intent acked. */
  | {
      readonly status: "skipped";
      readonly intentId: string;
      readonly claimId: string;
      readonly guard: string;
    }
  /** One provider attempt recorded (attempts + 1). */
  | {
      readonly status: "recorded";
      readonly intentId: string;
      readonly claimId: string;
      readonly state: string;
      readonly attempts: number;
      readonly retryClass: RetryClass | null;
      readonly providerOutcome: DispatchProviderOutcome;
      /** Provider-throw message, present only when the call threw (recorded `uncertain`). */
      readonly providerThrew?: string;
    }
  /**
   * T32b: the fenced drive refused BEFORE any provider call — the
   * dispatch presented its trigger's own checkpoint revision (an
   * inherited snapshot, never a fresh scope). No record, no ack, no
   * attempt consumed; the held claim ages out for re-drive. The echo
   * carries the fresh checkpoint beside the refused trigger point.
   */
  | {
      readonly status: "refused-inherited-scope";
      readonly intentId: string;
      readonly claimId: string;
      readonly fence: DriveDispatchFenceEcho;
    }
  /**
   * T32b: the fenced drive refused AFTER the guard passed — live
   * authority no longer holds (revoked between trigger and drive).
   * Same no-call/no-record/no-ack posture as inherited-scope; the
   * echo carries the checkpoint the refusal fenced under.
   */
  | {
      readonly status: "refused-revoked";
      readonly intentId: string;
      readonly claimId: string;
      readonly fence: DriveDispatchFenceEcho;
    };

/**
 * T32b: the fenced gate — one real kernel verdict for one won claim.
 * Opens the dispatch's OWN fresh checkpoint (current revision, zero
 * enrolled dependencies — never the triggering read's snapshot),
 * pulls the CURRENT snapshot, resolves the LIVE authority verdict at
 * fence time, and consults the injected `attemptDispatch` with the
 * committed guard ordering. Returns null on `claimed` (the drive
 * proceeds to the provider); `skipped` runs the shared skip ceremony;
 * refused verdicts return with the fence echo (no provider call, no
 * record, no ack — the held claim ages out and the sweeper re-drives
 * from scratch).
 */
async function runFenceGate(input: {
  readonly opts: DriveDispatchIntentOpts;
  readonly fence: DriveDispatchFenceInput;
  readonly intentId: string;
  readonly now: number;
  readonly heldClaimId: string;
  readonly guard: string | null;
  readonly recordSkip: (guardName: string) => Promise<DriveDispatchOutcome>;
}): Promise<DriveDispatchOutcome | null> {
  const { opts, fence, intentId, now, heldClaimId, guard, recordSkip } = input;
  if (typeof fence.owner !== "string" || fence.owner === "") {
    throw new Error("t32b: fenced drive needs a non-empty checkpoint owner.");
  }
  if (typeof fence.revalidateAuthority !== "function" || typeof fence.attemptDispatch !== "function") {
    throw new Error("t32b: fenced drive needs revalidateAuthority + attemptDispatch functions.");
  }
  const triggerRevision = fence.triggerRevision;
  if (triggerRevision !== undefined) {
    const rev: unknown = triggerRevision.revision;
    if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) {
      throw new Error("t32b: fenced drive triggerRevision must be an integer revision >= 0.");
    }
  }
  const admission = await loadFenceAdmissionProducer();
  const checkpoint = (await admission.openTransitiveScope(opts.store, fence.owner)).snapshot();
  // The CURRENT snapshot first (a side-effecting reader lands before
  // the live authority read — fence-time order, still after the
  // claim); unguarded dispatches skip the pull exactly like the
  // unfenced path (the kernel never reads the snapshot then).
  const snapshot: unknown = guard === null ? null : await opts.readStateSnapshot(opts.intent);
  // LIVE authority re-read at fence time (after the claim, after the
  // snapshot, before the provider call). The pure-sync kernel cannot
  // await it, so the drive resolves it here and the kernel replays
  // the resolved verdict — the REVOCATION verdict still lands after
  // the guard inside the kernel's committed ordering.
  const liveAuthorityOk = (await fence.revalidateAuthority()) === true;
  const verdict = checkFenceAttemptVerdict(
    fence.attemptDispatch(
      {
        clock: { nowMs: () => now },
        // Single-shot mint reproducing the HELD claim: the kernel
        // mints only on its claimed path, and the drive asserts the
        // minted claim equals the held one below.
        claimIds: { nextClaimId: () => heldClaimId },
        // Attested, not re-read: the claim run just proved pending +
        // non-superseded (it refuses superseded rows first), so a
        // re-read here could only observe the pre-existing
        // claim-to-provider race — which the unfenced path shares.
        supersessions: { isSuperseded: () => false },
        evaluateGuard: (predicate, frozenInputs, stateSnapshot) =>
          opts.evaluateGuard(predicate, frozenInputs, stateSnapshot),
      },
      {
        intent: {
          item: {
            id: intentId,
            operationId: opts.intent.operationId,
            source: opts.intent.target,
            occurrenceIndex: opts.intent.occurrenceIndex,
            request: opts.intent.arguments,
            originOccurrence: null,
            // The L3 intent is committed (it came from outboxPending)
            // and undispatched (unacked): pending in the kernel's
            // dispatchability sense. (The dispatch ROW is claimed —
            // row concurrency and intent dispatchability are separate
            // mechanisms; the row claim is what `heldClaimId` names.)
            state: "pending",
          },
          // Attested upper-bound marker: the intent committed no
          // later than now at no later than the fresh checkpoint
          // revision (the kernel null-checks it opaquely — lane 3
          // mints the authoritative marker at stage).
          commit: { revision: checkpoint.revision as number, committedAtMs: now },
        },
        guard: { predicate: guard },
        frozenInputs: opts.intent.arguments,
        stateSnapshot: snapshot,
        fence: {
          checkpoint: { revision: checkpoint.revision as number, owner: checkpoint.owner },
          ...(triggerRevision === undefined
            ? {}
            : { triggerRevision: { revision: triggerRevision.revision } }),
          revalidateAuthority: () => liveAuthorityOk,
        },
      },
    ),
  );
  const echo: DriveDispatchFenceEcho = {
    checkpoint: { revision: checkpoint.revision as number, owner: checkpoint.owner },
    triggerRevision: triggerRevision === undefined ? null : { revision: triggerRevision.revision },
  };
  if (verdict.status === "claimed") {
    if (
      verdict.claim.outboxId !== intentId ||
      verdict.claim.claimId !== heldClaimId ||
      verdict.claim.claimedAt !== now
    ) {
      throw new Error(`t32b: fence kernel minted a claim that is not the held claim (producer skew?)`);
    }
    return null;
  }
  if (verdict.status === "skipped") {
    if (guard === null) {
      throw new Error(`t32b: fence kernel skipped an unguarded dispatch (producer skew?)`);
    }
    return recordSkip(guard);
  }
  return { status: verdict.status, intentId, claimId: heldClaimId, fence: echo };
}

/**
 * T24b: drive ONE dispatch attempt for one L3 intent: fenced claim,
 * claim-time guard re-evaluation against a CURRENT snapshot, exactly
 * one provider call, and one fenced record-attempt. Single-shot
 * throughout: fence conflicts (`busy`) and evaluator throws propagate
 * (NO retry — callers decide; the held claim ages out through the
 * stale-claim path). A throwing or incoherent provider records
 * `uncertain` (it may have acted — unknown stays unknown instead of
 * retrying blind). Delivered and terminal outcomes ack the L3 intent;
 * transient and uncertain outcomes leave it for the sweeper. The row's
 * stage-time guard pin is recorded history: only the claim-time
 * re-eval verdict gates this attempt.
 */
export async function driveDispatchIntent(
  opts: DriveDispatchIntentOpts,
): Promise<DriveDispatchOutcome> {
  const intentId = opts.intent.intentId;
  if (typeof intentId !== "string" || intentId === "") {
    throw new Error("t24b: drive needs an intent with a non-empty intentId.");
  }
  const now = opts.nowMs();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("t24b: drive needs a finite nowMs >= 0.");
  }
  const claimId = opts.nextClaimId();
  if (typeof claimId !== "string" || claimId === "") {
    throw new Error("t24b: drive needs a non-empty claim id mint.");
  }
  if (!Number.isFinite(opts.maxClaimAgeMs) || opts.maxClaimAgeMs < 0) {
    throw new Error("t24b: drive needs a finite maxClaimAgeMs >= 0.");
  }
  const runBase = { actor: opts.actor, now, operation: opts.operation };
  const claimed = await opts.registry.run(
    "work.dispatch.claim",
    { intentId, claimId, claimedAtMs: now, maxClaimAgeMs: opts.maxClaimAgeMs },
    { ...runBase, operationId: opts.claimOperationId },
    { store: opts.store },
  );
  const claim = checkClaimResult(claimed.result);
  if (!claim.claimed || claim.claimId === null) {
    return { status: "not-claimed", intentId, reason: claim.reason ?? "unknown" };
  }
  const heldClaimId = claim.claimId;
  const guard: string | null = opts.intent.dispatchGuard ?? null;
  // The skip ceremony (ONE implementation, shared by the unfenced
  // re-eval below and the fenced kernel's `skipped` verdict): a false
  // guard records WITHOUT consuming an attempt and acks the L3 intent.
  const recordSkip = async (guardName: string): Promise<DriveDispatchOutcome> => {
    const skipped = await opts.registry.run(
      "work.dispatch.record-attempt",
      {
        intentId,
        claimId: heldClaimId,
        outcome: { state: "pending", guardVerdict: false },
        ack: true,
      },
      { ...runBase, operationId: opts.recordOperationId },
      { store: opts.store },
    );
    checkRecordResult(skipped.result);
    return { status: "skipped", intentId, claimId: heldClaimId, guard: guardName };
  };
  if (opts.fence === undefined) {
    // Claim-time guard re-evaluation: the CURRENT snapshot (pulled after
    // the win) through the injected evaluator. Only an explicit `true`
    // dispatches (mirroring `attemptDispatch` + `planDispatchStaging`);
    // anything else records a skip WITHOUT consuming an attempt.
    // Evaluator throws propagate with the claim held (stale release
    // owns the retry) — a throwing evaluator must never terminally
    // skip, and the pin it would overwrite is recorded history.
    if (guard !== null) {
      const snapshot = await opts.readStateSnapshot(opts.intent);
      const verdict = opts.evaluateGuard(guard, opts.intent.arguments, snapshot);
      if (verdict !== true) {
        return recordSkip(guard);
      }
    }
  } else {
    // T32b: the fenced gate — the guard re-eval moves INSIDE the real
    // kernel call (same evaluator, same snapshot, same single
    // evaluation), so refused-inherited-scope precedes the guard and
    // refused-revoked follows it per the committed ordering. Claimed
    // falls through to the provider below; anything else returns.
    const fenced = await runFenceGate({
      opts,
      fence: opts.fence,
      intentId,
      now,
      heldClaimId,
      guard,
      recordSkip,
    });
    if (fenced !== null) return fenced;
  }
  const held: DispatchClaim = {
    outboxId: intentId as OutboxId,
    claimId: heldClaimId as ClaimId,
    claimedAt: now,
  };
  let providerOutcome: DispatchProviderOutcome;
  let providerThrew: string | null = null;
  try {
    providerOutcome = checkProviderOutcome(await opts.callProvider(opts.intent, held));
  } catch (error) {
    providerThrew = error instanceof Error ? error.message : String(error);
    providerOutcome = { kind: "uncertain" };
  }
  let outcome: Record<string, unknown>;
  let ack: boolean;
  let retryClass: RetryClass | null = null;
  if (providerOutcome.kind === "delivered") {
    // The provider result surfaces ONLY in this drive outcome: the
    // dispatch row carries no result column, and `deliveryId` is the
    // store-minted delivery association (see `toReceiptObservation`),
    // never the provider payload — so it stays null here.
    outcome = { state: "delivered" };
    ack = true;
  } else if (providerOutcome.kind === "uncertain") {
    outcome = { state: "uncertain" };
    ack = false;
  } else {
    retryClass = opts.classifyFailure(providerOutcome.cause);
    if (retryClass !== "transient" && retryClass !== "terminal") {
      throw new Error("t24b: failure classifier must return transient or terminal.");
    }
    const closed = closedDispatchErrorForCause(providerOutcome.cause);
    outcome = {
      state: "failed",
      retryClass,
      errorCode: closed.code,
      errorMessage: closed.message,
    };
    ack = retryClass !== "transient";
  }
  const recorded = await opts.registry.run(
    "work.dispatch.record-attempt",
    { intentId, claimId: heldClaimId, outcome, ack },
    { ...runBase, operationId: opts.recordOperationId },
    { store: opts.store },
  );
  const record = checkRecordResult(recorded.result);
  return {
    status: "recorded",
    intentId,
    claimId: heldClaimId,
    state: record.state,
    attempts: record.attempts,
    retryClass,
    providerOutcome,
    ...(providerThrew === null ? {} : { providerThrew }),
  };
}

/* -- T24b recovery sweeper (recover -> plan -> requeue/reconcile/release). -- */

/** T24b: recovery sweep options. */
export interface RecoverySweepOpts {
  readonly registry: DispatchSystemRegistry;
  /** Join-wrapped store: registry runs commit linkage-asserted. */
  readonly store: StoragePort;
  /** Join port for reconcile batches (fenced update + ack, atomically). */
  readonly joinPort: DispatchJoinPort;
  readonly actor: string;
  readonly operation: string;
  /** Sweep instant, read ONCE: recover, scans, and the plan share it. */
  readonly nowMs: () => number;
  readonly maxClaimAgeMs: number;
  /** Retry budget for requeue acts (attempt cap + horizon, both enforced). */
  readonly policy: RetryPolicy;
  /** Bound per scan (recover batch + each state scan); integer >= 1. */
  readonly limit: number;
  /** Recover cursor: resume a truncated claimed scan where it stopped. */
  readonly resumeAfter?: string | null;
  /** Run operationId per step (recover once; requeue/release per intent). */
  readonly operationIdForStep: (
    step: "recover" | "requeue" | "release",
    intentId?: string,
  ) => string;
  /** Injected recovery planner (the real work `planRecoveryScan`). */
  readonly planRecoveryScan: DispatchRecoveryPlanner;
  /** Injected reconcile-evidence reader (provider-evidence plumbing). */
  readonly readEvidence: DispatchEvidenceReader;
}

/** T24b: one requeue act outcome (retry and dead lists alike). */
export interface RecoverySweepRequeueAct {
  readonly intentId: string;
  readonly requeued: boolean;
  readonly dead: boolean;
  readonly reason?: string;
}

/** T24b: one planner-resume release act outcome. */
export interface RecoverySweepReleaseAct {
  readonly intentId: string;
  readonly released: boolean;
}

/** T24b: one reconciled uncertain row. */
export interface RecoverySweepReconcileAct {
  readonly intentId: string;
  readonly state: string;
}

/** T24b: one reconcile skip (evidence or row moved under the plan). */
export interface RecoverySweepSkip {
  readonly intentId: string;
  readonly reason: string;
}

/** T24b: recovery sweep summary (every observed row accounted for). */
export interface RecoverySweepResult {
  /** Stale claims released by the fenced batch recover. */
  readonly released: ReadonlyArray<string>;
  /** Planner-resume extras released per intent (empty when recover covered them). */
  readonly resumed: ReadonlyArray<RecoverySweepReleaseAct>;
  /** Retry-list requeue outcomes (failed-transient + uncertain not-found). */
  readonly retried: ReadonlyArray<RecoverySweepRequeueAct>;
  /** Dead-list requeue outcomes (dead-letter when exhausted). */
  readonly deadLettered: ReadonlyArray<RecoverySweepRequeueAct>;
  /** Uncertain rows reconciled with decisive evidence (update + ack, atomic). */
  readonly reconciled: ReadonlyArray<RecoverySweepReconcileAct>;
  /** Reconcile-list rows skipped (evidence/row moved; retried next sweep). */
  readonly reconcileSkipped: ReadonlyArray<RecoverySweepSkip>;
  /** Uncertain rows without evidence: untouched until evidence arrives. */
  readonly awaiting: ReadonlyArray<string>;
  /** Guard-false pinned rows: never dispatched, listed never silent. */
  readonly skipped: ReadonlyArray<string>;
  /** Failed-terminal (or unclassified) rows: final, never retried. */
  readonly terminal: ReadonlyArray<string>;
  /** Recover cursor for the claimed scan (`done: false` means resume). */
  readonly resumeAfter: string | null;
  readonly done: boolean;
  /** Uncertain ids observed by recover (read-only; the planner decides). */
  readonly uncertain: ReadonlyArray<string>;
  readonly uncertainTruncated: boolean;
  /** Per-state scan truncation (bounded sweeps never silently truncate). */
  readonly truncated: {
    readonly failed: boolean;
    readonly uncertain: boolean;
    readonly pending: boolean;
    readonly claimed: boolean;
  };
}

function checkRecoveryPlan(value: unknown): DispatchRecoveryPlan {
  if (!isUnknownRecord(value)) {
    throw new Error("t24b: recovery plan must be an object (planner skew?).");
  }
  return {
    resume: checkStringList(value["resume"], "recovery plan resume"),
    retry: checkStringList(value["retry"], "recovery plan retry"),
    reconcile: checkStringList(value["reconcile"], "recovery plan reconcile"),
    awaiting: checkStringList(value["awaiting"], "recovery plan awaiting"),
    skipped: checkStringList(value["skipped"], "recovery plan skipped"),
    terminal: checkStringList(value["terminal"], "recovery plan terminal"),
    dead: checkStringList(value["dead"], "recovery plan dead"),
  };
}

async function scanDispatchState(
  store: StoragePort,
  state: OutboxItemState,
  limit: number,
): Promise<{ readonly rows: DispatchExecutionRowData[]; readonly truncated: boolean }> {
  const found = await store.query(dispatchExecutionByStateQuery(state));
  const rows: DispatchExecutionRowData[] = [];
  const seen = new Set<string>();
  for (const row of found) {
    const data = readDispatchExecutionRow(row);
    // Exact re-filter: state match, first sighting (adapters may echo).
    if (data.state !== state) continue;
    if (seen.has(data.intentId)) continue;
    seen.add(data.intentId);
    rows.push(data);
  }
  rows.sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0));
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

async function commitReconcile(input: {
  readonly store: StoragePort;
  readonly joinPort: DispatchJoinPort;
  readonly actor: string;
  readonly now: number;
  readonly intentId: string;
  readonly evidence: DispatchReconcileEvidence;
}): Promise<{ readonly reconciled: true; readonly state: string } | { readonly reconciled: false; readonly reason: string }> {
  const row = await input.store.load(T24B_WORK_DISPATCH_MODEL, input.intentId as RecordId);
  if (row === null) {
    return { reconciled: false, reason: "row-missing" };
  }
  const data = readDispatchExecutionRow(row);
  if (data.state !== "uncertain") {
    return { reconciled: false, reason: "state-changed" };
  }
  if (input.evidence.kind !== "delivered" && input.evidence.kind !== "failed") {
    return { reconciled: false, reason: "evidence-changed" };
  }
  const nextData =
    input.evidence.kind === "delivered"
      ? { ...data, state: "delivered" as OutboxItemState }
      : {
          ...data,
          state: "failed" as OutboxItemState,
          errorCode: input.evidence.code,
          errorMessage: input.evidence.message,
        };
  // Attempts UNCHANGED (reconcile parity with `reconcileUncertain` —
  // reconcile resolves ambiguity, it is not an attempt); failed
  // evidence carries no classification, so `retryClass` stays null
  // (unclassified failed rows are terminal per the requeue rule).
  const batch: CommitBatch = {
    expectedRevision: await input.store.readRevision(),
    writes: [
      {
        kind: "update",
        model: T24B_WORK_DISPATCH_MODEL,
        id: row.id,
        expectedVersion: row.version,
        row: {
          ...row,
          version: ((row.version as number) + 1) as RecordVersion,
          updated: input.now,
          updatedBy: input.actor,
          data: { ...nextData },
        },
      },
    ],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
    outboxAck: [input.intentId],
  };
  await input.joinPort.commitJoin(batch);
  return { reconciled: true, state: input.evidence.kind };
}

/**
 * T24b: run one bounded recovery sweep: fenced batch recover of stale
 * claims, bounded state scans into planner views, one
 * `planRecoveryScan` through the injected engine planner, then fenced
 * acts per plan list — per-intent release for planner-resume extras,
 * requeue for retry (uncertain rows re-attest `notFound` at act time)
 * and dead (dead-letters when exhausted), and fenced update + ack for
 * reconcile with decisive evidence. Awaiting/skipped/terminal rows
 * are reported and NEVER re-driven. Single-shot throughout: fence
 * conflicts propagate (NO retry — every act is repeatable, so callers
 * re-sweep); races between plan and act report as skips/refusals,
 * never forced commits. Deferrals (`availableAtMs`) are honored by
 * requeue when staged; the driver stages none, so sweep cadence is
 * the caller's pacing.
 */
export async function runRecoverySweep(opts: RecoverySweepOpts): Promise<RecoverySweepResult> {
  const now = opts.nowMs();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("t24b: sweep needs a finite nowMs >= 0.");
  }
  if (!Number.isFinite(opts.maxClaimAgeMs) || opts.maxClaimAgeMs < 0) {
    throw new Error("t24b: sweep needs a finite maxClaimAgeMs >= 0.");
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new Error("t24b: sweep needs a limit as an integer >= 1.");
  }
  if (!Number.isInteger(opts.policy.maxAttempts) || opts.policy.maxAttempts < 1) {
    throw new Error("t24b: sweep needs policy.maxAttempts as an integer >= 1.");
  }
  if (!Number.isFinite(opts.policy.horizonMs) || opts.policy.horizonMs <= 0) {
    throw new Error("t24b: sweep needs policy.horizonMs finite and > 0.");
  }
  const resumeAfter = opts.resumeAfter ?? null;
  if (resumeAfter !== null && (typeof resumeAfter !== "string" || resumeAfter === "")) {
    throw new Error("t24b: sweep resumeAfter must be a non-empty string or null.");
  }
  const runBase = { actor: opts.actor, now, operation: opts.operation };
  const recovered = await opts.registry.run(
    "work.dispatch.recover",
    {
      maxClaimAgeMs: opts.maxClaimAgeMs,
      limit: opts.limit,
      ...(resumeAfter === null ? {} : { resumeAfter }),
    },
    { ...runBase, operationId: opts.operationIdForStep("recover") },
    { store: opts.store },
  );
  const recover = checkRecoverResult(recovered.result);
  const failed = await scanDispatchState(opts.store, "failed", opts.limit);
  const uncertain = await scanDispatchState(opts.store, "uncertain", opts.limit);
  const pending = await scanDispatchState(opts.store, "pending", opts.limit);
  const claimed = await scanDispatchState(opts.store, "claimed", opts.limit);
  const views: DispatchRecoverableRow[] = [];
  const claims: DispatchClaim[] = [];
  const byId = new Map<string, DispatchExecutionRowData>();
  for (const scanned of [failed, uncertain, pending, claimed]) {
    for (const row of scanned.rows) {
      if (byId.has(row.intentId)) continue;
      byId.set(row.intentId, row);
      views.push({
        item: {
          id: row.intentId as OutboxId,
          operationId: row.operationId,
          source: row.source,
          occurrenceIndex: row.occurrenceIndex,
          // The planner reads id/state/attempts only; the frozen
          // provider inputs live on the L3 intent, not the row.
          request: {},
          originOccurrence: row.originOccurrence,
          attempts: row.attempts,
          state: row.state,
        },
        guardVerdict: row.guardVerdict,
        firstAttemptAtMs: row.firstAttemptAtMs,
        retryClass: row.retryClass,
      });
      if (row.state === "claimed" && row.claimId !== null && row.claimedAtMs !== null) {
        claims.push({
          outboxId: row.intentId as OutboxId,
          claimId: row.claimId as ClaimId,
          claimedAt: row.claimedAtMs,
        });
      }
    }
  }
  const evidence = (id: string): DispatchReconcileEvidence | null =>
    checkEvidenceAnswer(opts.readEvidence(id), id);
  const plan = checkRecoveryPlan(
    opts.planRecoveryScan({
      rows: views,
      claims,
      evidence,
      nowMs: now,
      maxClaimAgeMs: opts.maxClaimAgeMs,
      policy: opts.policy,
    }),
  );
  const resumed: RecoverySweepReleaseAct[] = [];
  for (const intentId of plan.resume) {
    const released = await opts.registry.run(
      "work.dispatch.release",
      { intentId, maxClaimAgeMs: opts.maxClaimAgeMs },
      { ...runBase, operationId: opts.operationIdForStep("release", intentId) },
      { store: opts.store },
    );
    resumed.push({ intentId, released: checkReleaseResult(released.result).released });
  }
  const requeueOne = async (
    intentId: string,
    notFound: boolean,
  ): Promise<RecoverySweepRequeueAct> => {
    const acted = await opts.registry.run(
      "work.dispatch.requeue",
      {
        intentId,
        maxAttempts: opts.policy.maxAttempts,
        horizonMs: opts.policy.horizonMs,
        ...(notFound ? { notFound: true } : {}),
      },
      { ...runBase, operationId: opts.operationIdForStep("requeue", intentId) },
      { store: opts.store },
    );
    const outcome = checkRequeueResult(acted.result);
    return {
      intentId,
      requeued: outcome.requeued,
      dead: outcome.dead,
      ...(outcome.reason === null ? {} : { reason: outcome.reason }),
    };
  };
  const retried: RecoverySweepRequeueAct[] = [];
  for (const intentId of plan.retry) {
    const view = byId.get(intentId);
    if (view !== undefined && view.state === "uncertain") {
      // Uncertain rows re-attest at act time: only a CURRENT
      // not-found attestation requeues (evidence may have moved
      // between plan and act — never force on stale evidence).
      const current = evidence(intentId);
      if (current === null || current.kind !== "not-found") {
        retried.push({ intentId, requeued: false, dead: false, reason: "evidence-changed" });
        continue;
      }
      retried.push(await requeueOne(intentId, true));
    } else {
      retried.push(await requeueOne(intentId, false));
    }
  }
  const deadLettered: RecoverySweepRequeueAct[] = [];
  for (const intentId of plan.dead) {
    deadLettered.push(await requeueOne(intentId, false));
  }
  const reconciled: RecoverySweepReconcileAct[] = [];
  const reconcileSkipped: RecoverySweepSkip[] = [];
  for (const intentId of plan.reconcile) {
    const current = evidence(intentId);
    if (current === null || current.kind === "not-found") {
      reconcileSkipped.push({
        intentId,
        reason: current === null ? "awaiting-evidence" : "evidence-changed",
      });
      continue;
    }
    const outcome = await commitReconcile({
      store: opts.store,
      joinPort: opts.joinPort,
      actor: opts.actor,
      now,
      intentId,
      evidence: current,
    });
    if (outcome.reconciled) {
      reconciled.push({ intentId, state: outcome.state });
    } else {
      reconcileSkipped.push({ intentId, reason: outcome.reason });
    }
  }
  return {
    released: recover.released,
    resumed,
    retried,
    deadLettered,
    reconciled,
    reconcileSkipped,
    awaiting: plan.awaiting,
    skipped: plan.skipped,
    terminal: plan.terminal,
    resumeAfter: recover.resumeAfter,
    done: recover.done,
    uncertain: recover.uncertain,
    uncertainTruncated: recover.uncertainTruncated,
    truncated: {
      failed: failed.truncated,
      uncertain: uncertain.truncated,
      pending: pending.truncated,
      claimed: claimed.truncated,
    },
  };
}
