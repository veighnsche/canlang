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
 * arrays, planner, classifier) arrive through the injected assembly
 * seam using work's declared APIs. Provider calls, guard evaluation, evidence, and
 * snapshots are caller-supplied ports — BOUND provider sends are
 * explicitly OUT (T24a remainder): this wiring calls through the
 * injected ports only and never binds a send target itself.
 *
 * T34-F7 (the section after T24b, additive): fanout assembly/runtime
 * join — atomic trigger/intent staging, the fair resumable scheduler,
 * and the DURABLE fenced claim/record replacements for F3's TEST-ONLY
 * store. Additive only: no T24b/T32b path above is modified.
 */
import type {
  ArtifactCohortDescriptor,
  ClaimId,
  CompileArtifact,
  ColumnMeta,
  ListQueryArgs,
  ListQueryResult,
  QueryPredicate,
  DispatchClaim,
  DomainWrite,
  FanoutChildId,
  FanoutChildOutcome,
  FanoutCohortDiagnosis,
  FanoutCohortKind,
  FanoutFailedReason,
  FanoutId,
  FanoutProgress,
  FanoutSkippedReason,
  HistoryEntry,
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
  Receipt,
  ReceiptProperty,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  RetryClass,
  RetryPolicy,
  Revision,
  ScheduleOp,
  CommitBatch,
  CommitResult,
  ProjectedRecord,
  SelectedReceiptProjection,
  StoragePort,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
} from "@canlang/contracts";
import { COLLECTION_DEFAULT_LIMIT, COLLECTION_MAX_LIMIT } from "@canlang/contracts";
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
function collectSources(artifact: CompileArtifact, asm: AssembledModules): string[] {
  const out: string[] = [];
  for (const mod of artifact.modules) {
    const map = asm.sourceMaps !== undefined && Object.hasOwn(asm.sourceMaps, mod.path) ? asm.sourceMaps[mod.path] : mod.map;
    const sources: unknown = map?.sources;
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
    const sources = collectSources(artifact, asm).sort((a, b) => b.length - a.length);
    for (const frame of parseStackFrames(error.stack)) {
      const module = matchGeneratedModule(frame.file, exact, suffixes);
      if (module !== null) {
        const mod = artifact.modules.find((entry) => entry.path === module);
        if (mod === undefined) return undefined;
        // V8 columns are 1-based; `lookup` takes a 0-based generated column.
        const map = asm.sourceMaps !== undefined && Object.hasOwn(asm.sourceMaps, module) ? asm.sourceMaps[module] : mod.map;
        return map === undefined ? undefined : lookup(map, frame.line, frame.column - 1) ?? undefined;
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
/* the emitted `canApp().policy.operations[name]` manifest. B7          */
/* fail-closed: absent entry (the emitter returns None iff the          */
/* operation carries no admission content at all) denies via            */
/* `{not: "public"}` (S4 "no policy means deny" — per-call typed        */
/* denial); role-only `by` spellings map 1:1 (builtins literal,         */
/* declared roles to `{role}`, multiples to `{and}` — the emitter       */
/* joins guards with `&&`); anything else (`gated`, `when`,             */
/* `requires`, malformed or unknown members) refuses the whole set      */
/* LOUD at load, naming T04b, instead of running unguarded. Scenario    */
/* operations join the same transcription (absent -> deny); their       */
/* leading `require` guards are dropped from the outer gate because     */
/* the emitted handler still runs them inlined post-admission           */
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
 * This structural view is restated at the dynamic assembly boundary;
 * the loader validates every value at runtime, so drift fails
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
 * B7 fail-closed: absent entry -> `{not: "public"}` (no admission
 * content is DENY — S4 "no policy means deny"; the always-false
 * predicate in existing vocabulary, so gateless operations fail
 * per-call with typed denial instead of admitting). Role-only `by`
 * spellings map 1:1 (predicate spellings verbatim, declared roles
 * to `{role}`, multiples to `{and}` per the emitter's `&&` join).
 * Every other content — `gated` (subject/expression/compound gates
 * collapsed by the emitter), `when` (the predicate is emitted code,
 * not data), `requires`, malformed shapes, unknown members —
 * refuses LOUD: the pipeline enforces nothing itself, so an
 * untranscribable gate must block the set (T04b carries generated
 * policy) rather than run unguarded. Plain `Error` (caller-side
 * refusal, mirroring the loader's engine-local policy channel).
 */
export function mapCrudPolicyToBy(opName: string, entry: unknown): CanonicalByPredicate {
  if (entry === undefined || entry === null) return { not: "public" };
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

/**
 * B7: scenario admission transcription. Same mapping as CRUD
 * (absent -> deny, role-only `by` 1:1, gated/when/malformed loud)
 * EXCEPT the entry's `requires` count is dropped before
 * delegating: scenario leading `require` guards execute inlined in
 * the emitted handler post-admission (interim-exact — the handler
 * runs for scenarios, unlike the CRUD pipeline which skips it),
 * so the outer gate transcribes `by` only. A scenario with no
 * entry at all still denies (missing guard is a defect, S5) —
 * its inlined guards never get to run.
 */
export function mapScenarioPolicyToBy(opName: string, entry: unknown): CanonicalByPredicate {
  if (!isUnknownRecord(entry)) return mapCrudPolicyToBy(opName, entry);
  const { requires: _handlerEnforced, ...admission } = entry;
  return mapCrudPolicyToBy(opName, admission);
}

/* ------------------------------------------------------------------ */
/* Read-policy transcription joins public rule marks to their owning   */
/* appDefinition model readGrants. State owns typed-secret metadata and */
/* grant validation/projection; serverOnly governs caller inputs only. */
/* Unevaluable rules retain their existing per-read refusal posture.    */
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
  const where = `t17b: model ${JSON.stringify(model)}`;
  const policy = readMetadataMember(registry, "policy", where)?.value;
  if (policy === undefined || policy === null) return undefined;
  if (!isUnknownRecord(policy)) {
    throw new Error(
      `t17b: model ${JSON.stringify(model)}: malformed read policy ` +
        `(policy member is not an object)`,
    );
  }
  const models = readMetadataMember(policy, "models", where)?.value;
  if (models === undefined || models === null) return undefined;
  if (!isUnknownRecord(models)) {
    throw new Error(
      `t17b: model ${JSON.stringify(model)}: malformed read policy ` +
        `(policy.models is not an object)`,
    );
  }
  return readMetadataMember(models, model, where)?.value;
}

/** One model's transcribed read posture: servable grants or ruled refusal. */
export interface TranscribedReadPolicy {
  /** True when the model carries read rules with no public marks (serve-time `validation`, never served). */
  readonly ruled: boolean;
  /** The table-builder input; `null` when ruled (ruled models are omitted from the table). */
  readonly input: CanonicalModelPolicyInput | null;
}

/** Owning declaration and callable registry from the same assembled module. */
export interface ReadPolicyProvenance {
  readonly secretFields: ReadonlyArray<string>;
  readonly declaration?: unknown;
  readonly readRules?: unknown;
}

interface ReadPolicyFacts {
  readonly read?: ReadonlyArray<string>;
  readonly public?: ReadonlyArray<string>;
  readonly invariants?: ReadonlyArray<string>;
  readonly locks?: ReadonlyArray<string>;
}
interface ReadSelectorFacts {
  readonly fields: ReadonlyArray<string>;
  readonly grants: ReadonlyMap<string, ReadonlyArray<string> | undefined>;
}

/** Emitted metadata owns data properties; accessor execution is not provenance. */
function readMetadataMember(object: object, key: string, where: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw new Error(`${where}: accessor metadata member ${JSON.stringify(key)} is unsupported.`);
  }
  return { value: descriptor.value as unknown };
}

/** Admit one fixed dense interval of own data; array methods/getters are not evidence. */
function readMetadataArray(value: unknown, where: string, member: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where}: malformed ${member} (array).`);
  const length = readMetadataMember(value, "length", where)?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${where}: malformed ${member} length.`);
  }
  const indices = Object.getOwnPropertyNames(value).filter((key) =>
    /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 0xffff_ffff);
  if (indices.length !== length) throw new Error(`${where}: malformed ${member} (dense own keys).`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const element = readMetadataMember(value, String(index), where);
    if (element === undefined) throw new Error(`${where}: malformed ${member} (dense own elements).`);
    result.push(element.value);
  }
  return result;
}

function readMetadataStrings(value: unknown, where: string, member: string): string[] {
  const elements = readMetadataArray(value, where, member);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    if (typeof element !== "string" || element.length === 0 || seen.has(element)) {
      throw new Error(`${where}: malformed ${member} (dense own unique non-empty strings).`);
    }
    seen.add(element);
    result.push(element);
  }
  return result;
}

function readPolicyFacts(entry: unknown, where: string): ReadPolicyFacts {
  if (entry === undefined || entry === null) return {};
  if (!isUnknownRecord(entry)) throw new Error(`${where}: malformed policy entry (not an object).`);
  for (const key of Object.keys(entry)) {
    if (key !== "read" && key !== "public" && key !== "invariants" && key !== "locks") {
      throw new Error(`${where}: unknown policy member ${JSON.stringify(key)}.`);
    }
  }
  const facts: { read?: string[]; public?: string[]; invariants?: string[]; locks?: string[] } = {};
  for (const key of ["public", "read", "invariants", "locks"] as const) {
    const value = readMetadataMember(entry, key, where)?.value;
    if (value !== undefined) facts[key] = readMetadataStrings(value, where,
      key === "public" ? "public marks" : key === "read" ? "read rules" : key);
  }
  const rules = new Set(facts.read ?? []);
  if (rules.size === 0 && (facts.public?.length ?? 0) > 0) {
    throw new Error(`${where}: public marks without read rules (emitter skew?).`);
  }
  for (const id of facts.public ?? []) {
    if (!rules.has(id)) throw new Error(`${where}: public mark ${JSON.stringify(id)} names no emitted rule (emitter skew?).`);
  }
  return facts;
}

function readSelectorFacts(
  policy: ReadPolicyFacts,
  declaredFields: ReadonlyArray<string>,
  provenance: ReadPolicyProvenance | undefined,
  where: string,
): ReadSelectorFacts | undefined {
  if ((policy.public?.length ?? 0) === 0) return undefined;
  const declaration = provenance === undefined ? undefined : readMetadataMember(provenance, "declaration", where)?.value;
  const readRules = provenance === undefined ? undefined : readMetadataMember(provenance, "readRules", where)?.value;
  if (!isUnknownRecord(declaration) || !isUnknownRecord(readRules)) {
    throw new Error(`${where}: missing owning read selector provenance.`);
  }
  const grantsMember = readMetadataMember(declaration, "readGrants", where);
  if (grantsMember === undefined) throw new Error(`${where}: missing owning read selector provenance.`);
  const fields = readMetadataMember(declaration, "fields", where)?.value;
  if (!isUnknownRecord(fields) || Object.keys(fields).length !== declaredFields.length) {
    throw new Error(`${where}: owning model fields disagree with loaded model (emitter skew?).`);
  }
  for (const field of declaredFields) {
    if (!Object.hasOwn(fields, field)) throw new Error(`${where}: owning model fields disagree with loaded model (emitter skew?).`);
  }
  const declarations = readMetadataArray(grantsMember.value, where, "readGrants declaration");
  const rules = new Set(policy.read ?? []);
  const fieldNames = new Set(declaredFields);
  const selectors = new Map<string, ReadonlyArray<string> | undefined>();
  for (const grant of declarations) {
    const id = isUnknownRecord(grant) ? readMetadataMember(grant, "rule", where)?.value : undefined;
    if (!isUnknownRecord(grant) || typeof id !== "string" || !rules.has(id) || selectors.has(id)) {
      throw new Error(`${where}: malformed or skewed readGrants rule identity.`);
    }
    if (typeof readMetadataMember(readRules, id, where)?.value !== "function") {
      throw new Error(`${where}: read rule ${JSON.stringify(id)} has no owning callable.`);
    }
    const fieldsMember = readMetadataMember(grant, "fields", where);
    if (fieldsMember === undefined && "fields" in grant) {
      throw new Error(`${where}: inherited read selector on ${JSON.stringify(id)}.`);
    }
    let selected: string[] | undefined;
    if (fieldsMember !== undefined) {
      selected = readMetadataStrings(fieldsMember.value, where, `read selector on ${JSON.stringify(id)}`);
      if (selected.length === 0) throw new Error(`${where}: malformed empty read selector on ${JSON.stringify(id)}.`);
      for (const field of selected) {
        const parts = field.split(".");
        if (parts.some((part) => part.length === 0) || !fieldNames.has(parts[0]!)) {
          throw new Error(`${where}: malformed or undeclared read selector on ${JSON.stringify(id)}.`);
        }
      }
    }
    selectors.set(id, selected);
  }
  if (selectors.size !== rules.size) throw new Error(`${where}: readGrants and policy rule identities disagree (emitter skew?).`);
  for (const id of rules) {
    if (!selectors.has(id)) throw new Error(`${where}: readGrants and policy rule identities disagree (emitter skew?).`);
  }
  return { fields: [...declaredFields], grants: selectors };
}

function sameReadStrings(left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string> | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
function sameReadPolicies(left: ReadPolicyFacts, right: ReadPolicyFacts): boolean {
  return sameReadStrings(left.read, right.read) && sameReadStrings(left.public, right.public) &&
    sameReadStrings(left.invariants, right.invariants) && sameReadStrings(left.locks, right.locks);
}
function sameReadSelectors(left: ReadSelectorFacts | undefined, right: ReadSelectorFacts | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!sameReadStrings(left.fields, right.fields) || left.grants.size !== right.grants.size) return false;
  for (const [id, fields] of left.grants) {
    if (!right.grants.has(id) || !sameReadStrings(fields, right.grants.get(id))) return false;
  }
  return true;
}

function transcribeReadFacts(
  model: string,
  policy: ReadPolicyFacts,
  declaredFields: ReadonlyArray<string>,
  secretFields: ReadonlyArray<string>,
  selectors: ReadSelectorFacts | undefined,
): TranscribedReadPolicy {
  if ((policy.read?.length ?? 0) > 0 && (policy.public?.length ?? 0) === 0) return { ruled: true, input: null };
  const secrets = new Set(secretFields);
  return { ruled: false, input: {
    model, secretFields: [...secretFields],
    grants: (policy.public ?? []).map((id) => {
      if (selectors === undefined || !selectors.grants.has(id)) {
        throw new Error(`t17b: model ${JSON.stringify(model)} read selector identity is missing.`);
      }
      const selected = selectors.grants.get(id);
      return { by: "public", fields: [...(selected ?? declaredFields.filter((field) => !secrets.has(field)))] };
    }),
  } };
}

/** Transcribe only proven public rules, preserving their exact declared selectors. */
export function mapReadRulesToPolicy(
  model: string,
  entry: unknown,
  declaredFields: ReadonlyArray<string>,
  provenance?: ReadPolicyProvenance,
): TranscribedReadPolicy {
  const where = `t17b: model ${JSON.stringify(model)} cannot serve reads in the T17 core scope (T04b carries generated policy)`;
  const policy = readPolicyFacts(entry, where);
  const fields = readMetadataStrings(declaredFields, where, "declared fields");
  const selectors = readSelectorFacts(policy, fields, provenance, where);
  const secretFields = provenance === undefined ? undefined : readMetadataMember(provenance, "secretFields", where)?.value;
  const secrets = readMetadataStrings(secretFields ?? [], where, "secret fields");
  return transcribeReadFacts(model, policy, fields, secrets, selectors);
}

/* ------------------------------------------------------------------ */
/* Dynamic producers (state dist + contracts values).                   */
/* ------------------------------------------------------------------ */

/**
 * State producers resolve through declared installed package exports.
 * The Worker bundler rewrites these to owning vendor modules
 * (`env-assembly.ts` precedent).
 */
const STATE_REGISTRY_SPECIFIER = "@canlang/state/invocation/registry";
const STATE_INVOKE_SPECIFIER = "@canlang/state/invocation/invoke";
const STATE_CRUD_SPECIFIER = "@canlang/state/mutation/crud";
const STATE_MODELS_SPECIFIER = "@canlang/state/mutation/models";
const STATE_ERRORS_SPECIFIER = "@canlang/state/errors";
/** T17b: bound read port (`createReadInvoker`, the assembly read entry). */
const STATE_TRANSACT_SPECIFIER = "@canlang/state/ports/transact";
/** T17b: policy-table builder (`buildPolicyTable`, validates transcriptions). */
const STATE_GRANTS_SPECIFIER = "@canlang/state/policy/grants";
/** T17b: mutation pipeline (`runMutationWrites`, stages scenario writes). */
const STATE_PIPELINE_SPECIFIER = "@canlang/state/mutation/pipeline";

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
    /**
     * C2 production joins (B1/B2/B5): engine-local channels the frozen
     * intake cannot hold, passed through to the table builder beside
     * `refs` (never inspected here). T18 `serverInits` (model, then
     * field, then init kind), T18 `nullableFields` (model, then
     * known-nullable field names), B5 `containment` (model, then the
     * declared-ownership member). B3 `deliveryFields` (model, then
     * delivery-tagged field names) rides alongside for the T25
     * receipt join (consumed downstream, never by the table builder).
     */
    readonly serverInits: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
    readonly nullableFields: ReadonlyMap<string, ReadonlySet<string>>;
    readonly secretFields: ReadonlyMap<string, ReadonlySet<string>>;
    readonly containment: ReadonlyMap<string, unknown>;
    readonly deliveryFields: ReadonlyMap<string, ReadonlySet<string>>;
  };
  /**
   * R01: the loader's own whole-set rejection class, for the
   * pre-retry dropped-entry validation (the retry must throw
   * errors indistinguishable from what the loader would have
   * thrown had the kind been known — same class, reason, and
   * message vocabulary). Retires with the C3 strip.
   */
  readonly IncompatibleArtifactError: new (
    reason: string,
    message: string,
  ) => Error;
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
  readonly recordRefs?: readonly { readonly param: string; readonly model: ModelName; readonly row: StoredRow }[];
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

/** Internal selection mirrors the defining State viewer-query handoff. */
export interface CanonicalReadSelection {
  readonly where?: QueryPredicate;
  readonly limit?: number;
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
    /**
     * C2/B2 (Q3): serverOnly exclusions for denial currents (mirror of
     * `ConflictServerOnly`). The holder builds it from the loaded
     * models; absent reads as unknown and stale-ref denials carry
     * metadata-only currents.
     */
    readonly conflictServerOnly?: ReadonlyMap<string, ReadonlySet<string>>;
  }): Promise<MutationResult>;
  /** T17b: canonical generated-read entry (scenario `records()` calls it per read). */
  invokeRead(input: {
    readonly registry: ReadonlyMap<string, unknown>;
    readonly envelope: {
      readonly operation: string;
      readonly inputs: Record<string, unknown>;
    };
    readonly identity: ResolvedIdentity;
    readonly selection?: CanonicalReadSelection;
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
      /**
       * C2 production joins (mirror of `CanonicalModelTableOptions`):
       * the loader's engine-local channels, forwarded verbatim. Every
       * member is optional at the producer (omission keeps the legacy
       * posture); the seam always forwards all four.
       */
      readonly serverInits?: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
      readonly nullableFields?: ReadonlyMap<string, ReadonlySet<string>>;
      readonly containment?: ReadonlyMap<string, unknown>;
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
    readonly selection?: CanonicalReadSelection;
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
  /**
   * D3b: REAL `matchGrants` (structural subset — the engine reads
   * `grants[].by/when` only). The receipt pre-load authZ evaluates
   * the owner row through it, the same primitive the join's
   * leaf-grant resolution uses.
   */
  matchGrants(
    policy: { readonly grants: ReadonlyArray<{ readonly by: unknown; readonly when?: unknown }> },
    byCtx: {
      readonly actorUserId: string | null;
      readonly teamId: string | null;
      readonly membership: Membership | null;
      readonly memberships: CanonicalMembershipReader;
    },
    row: StoredRow,
  ): Promise<ReadonlyArray<unknown>>;
}

/** T17b: one pipeline write as handed to `runMutationWrites` (no `when`: stdlib carries none). */
export interface CanonicalPipelineWrite {
  readonly transition?: { readonly field: string; readonly from: string; readonly to: string };
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
    /**
     * C2/B1: gate update/remove writes against archived targets with
     * the EXACT admission rule (`validation` / `Archived records
     * cannot be used here.`). CRUD inherits the gate from admission;
     * scenario-staged writes bypass per-write admission, so the seam
     * passes `true` for CRUD/scenario parity. Absent reads as false
     * (privileged direct callers may touch archived rows).
     */
    readonly gateArchivedTargets?: boolean;
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
  const matchGrants = requireProducerFn(
    grantsMod,
    "matchGrants",
    "state grants producer",
  );
  const runMutationWrites = requireProducerFn(
    pipelineMod,
    "runMutationWrites",
    "state pipeline producer",
  );
  const IncompatibleArtifactError = requireProducerFn(
    registryMod,
    "IncompatibleArtifactError",
    "state registry producer",
  );
  return {
    registry: {
      loadArtifactDescriptors: loadArtifactDescriptors as StateRegistryProducer["loadArtifactDescriptors"],
      IncompatibleArtifactError:
        IncompatibleArtifactError as unknown as StateRegistryProducer["IncompatibleArtifactError"],
    },
    invoke: {
      invoke: invoke as StateInvokeProducer["invoke"],
      invokeRead: invokeRead as StateInvokeProducer["invokeRead"],
    },
    crud: { generatedCrudExecute: generatedCrudExecute as StateCrudProducer["generatedCrudExecute"] },
    models: { buildModelTableFromCanonical: buildModelTableFromCanonical as StateModelsProducer["buildModelTableFromCanonical"] },
    errors: StateError as unknown as StateErrorsProducer,
    transact: { createReadInvoker: createReadInvoker as StateTransactProducer["createReadInvoker"] },
    grants: {
      buildPolicyTable: buildPolicyTable as StateGrantsProducer["buildPolicyTable"],
      matchGrants: matchGrants as StateGrantsProducer["matchGrants"],
    },
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
  "state.machines": "state",
  "state.parameters": "state",
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
          `canlang.builtins, state, state.machines, state.parameters, values.decimal, values.int64, values.money, values.temporal`,
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
    if (entry["inputStyle"] !== undefined &&
        (entry["inputStyle"] !== "parameters" || op.kind !== "scenario" ||
         !artifact.requires.some((requirement) => requirement.capability === "state.parameters" && requirement.min_version >= 1))) {
      throw new Error(`t16b: operation ${JSON.stringify(op.name)} has invalid callable inputStyle.`);
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
  readonly collectionColumns: ReadonlyMap<string, readonly ColumnMeta[]>;
  /** C3/B3: loader-built delivery-field schema, carried for the T25 receipt join (D3 consumes). */
  readonly deliveryFields: ReadonlyMap<string, ReadonlySet<string>>;
  readonly producers: CanonicalStateProducers;
  /** C2/B2 (Q3): holder-built serverOnly exclusions, passed to every invoke. */
  readonly conflictServerOnly: ReadonlyMap<string, ReadonlySet<string>>;
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
 * throws. B7 no-skip: modules without `policy`/`models` members feed
 * ABSENT (deny) rather than rule-less-public — an empty scan yields
 * no entries and every model transcribes zero grants.
 */
async function collectModelPolicyManifests(
  asm: AssembledModules,
  modelFields: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<Map<string, { policy: ReadPolicyFacts; selectors: ReadSelectorFacts | undefined; fieldTypes: ReadonlyMap<string, string> }>> {
  const merged = new Map<string, { policy: ReadPolicyFacts; selectors: ReadSelectorFacts | undefined; fieldTypes: ReadonlyMap<string, string> }>();
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
    const moduleWhere = `t17b: module ${JSON.stringify(module)}`;
    const policy = readMetadataMember(registry, "policy", moduleWhere)?.value;
    if (policy === undefined || policy === null) continue;
    if (!isUnknownRecord(policy)) {
      throw new Error(
        `t17b: module ${JSON.stringify(module)} carries a malformed policy member (not an object)`,
      );
    }
    const models = readMetadataMember(policy, "models", moduleWhere)?.value;
    if (models === undefined || models === null) continue;
    if (!isUnknownRecord(models)) {
      throw new Error(
        `t17b: module ${JSON.stringify(module)} carries a malformed policy.models map (not an object)`,
      );
    }
    for (const model of Object.keys(models)) {
      const where = `t17b: model ${JSON.stringify(model)}`;
      const entry = readMetadataMember(models, model, where)?.value;
      const facts = readPolicyFacts(entry, where);
      const definition = mod["appDefinition"];
      const declaredModels = isUnknownRecord(definition) ? readMetadataMember(definition, "models", where)?.value : undefined;
      const declaration = isUnknownRecord(declaredModels) ? readMetadataMember(declaredModels, model, where)?.value : undefined;
      const readRules = readMetadataMember(registry, "read", where)?.value;
      if ((facts.public?.length ?? 0) > 0) {
        const definitionPolicy = isUnknownRecord(definition) ? readMetadataMember(definition, "policy", where)?.value : undefined;
        const definitionModels = isUnknownRecord(definitionPolicy) ? readMetadataMember(definitionPolicy, "models", where)?.value : undefined;
        const definitionEntry = isUnknownRecord(definitionModels) ? readMetadataMember(definitionModels, model, where) : undefined;
        if (definitionEntry === undefined || !sameReadPolicies(readPolicyFacts(definitionEntry.value, where), facts)) {
          throw new Error(`${where} appDefinition/canApp policy disagreement.`);
        }
      }
      const fields = modelFields.get(model);
      if (fields === undefined && (facts.public?.length ?? 0) > 0) {
        throw new Error(`${where}: public selector names no loaded model.`);
      }
      const selectors = readSelectorFacts(facts, fields ?? [], { secretFields: [], declaration, readRules }, where);
      const declaredFields = isUnknownRecord(declaration) ? declaration["fields"] : undefined;
      const fieldTypes = new Map<string, string>();
      if (isUnknownRecord(declaredFields)) {
        for (const field of fields ?? []) {
          const fieldDeclaration = readMetadataMember(declaredFields, field, where)?.value;
          const type = isUnknownRecord(fieldDeclaration) ? readMetadataMember(fieldDeclaration, "type", where)?.value : undefined;
          if (typeof type === "string" && type !== "") fieldTypes.set(field, type);
        }
      }
      const previous = merged.get(model);
      if (previous === undefined) {
        merged.set(model, { policy: facts, selectors, fieldTypes });
      } else if (!sameReadPolicies(previous.policy, facts) || !sameReadSelectors(previous.selectors, selectors) || JSON.stringify([...previous.fieldTypes]) !== JSON.stringify([...fieldTypes])) {
        throw new Error(`${where} carries contradictory read policy across assembled modules (refusing an incoherent set)`);
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
 * C2/B2 (Q3): holder-built serverOnly exclusions for denial currents
 * (mirror of `ConflictServerOnly`: model, then serverOnly field
 * names). Models without serverOnly fields carry an EMPTY set (values
 * flow); the map is built once at load and passed to every invoke, so
 * stale-ref denials carry full currents instead of metadata-only.
 * Loud on skew (the loader guarantees boolean flags — anything else
 * is loader/artifact skew, and guessing here would leak or over-redact).
 */
function buildConflictServerOnly(
  models: ReadonlyArray<unknown>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const [index, model] of models.entries()) {
    const name = canonicalModelName(model, index);
    if (!isUnknownRecord(model)) {
      throw new Error(`c2: loaded model ${JSON.stringify(name)} is not an object (loader/artifact skew?)`);
    }
    const fields: unknown = model["fields"];
    if (!isUnknownRecord(fields)) {
      throw new Error(
        `c2: loaded model ${JSON.stringify(name)} carries no fields map (loader/artifact skew?)`,
      );
    }
    const names = new Set<string>();
    for (const [field, def] of Object.entries(fields)) {
      if (!isUnknownRecord(def) || typeof def["serverOnly"] !== "boolean") {
        throw new Error(
          `c2: field ${JSON.stringify(field)} on model ${JSON.stringify(name)} ` +
            `carries no boolean serverOnly flag (loader/artifact skew?)`,
        );
      }
      if (def["serverOnly"] === true) {
        names.add(field);
      }
    }
    map.set(name, names);
  }
  return map;
}

/**
 * C3: strip `delivery`-kind op inputs for the L3 descriptor load.
 * Delivery bindings are dispatch-layer only (E framing excludes them
 * and both transports' bound checkers reject submitted ones — the C3
 * agreement pins prove it), so L3 can never observe a delivery value
 * and its descriptors must not name the kind the L3 loader rejects.
 * Shallow-copies only the touched levels; never mutates the caller
 * artifact. DELETE THIS when the state loader accepts delivery op
 * inputs (B-loader-tolerance): the retry below then never triggers,
 * and this helper becomes dead code to remove with its pins.
 */
/**
 * R01: the ONE delivery-entry predicate shared by the C3 strip and
 * the pre-retry validation — an entry the strip drops is exactly
 * an entry the validation checks (no drift between dropped and
 * checked sets).
 */
function isDeliveryInputEntry(entry: unknown): boolean {
  if (!isUnknownRecord(entry)) return false;
  const field: unknown = entry["field"];
  return isUnknownRecord(field) && field["kind"] === "delivery";
}

function stripDeliveryInputs(artifact: CompileArtifact): CompileArtifact {
  const operations = (artifact as unknown as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return artifact;
  let stripped = false;
  const mapped = operations.map((op) => {
    if (!isUnknownRecord(op)) return op;
    const inputs: unknown = op["inputs"];
    if (!isUnknownRecord(inputs)) return op;
    const fields: unknown = inputs["fields"];
    if (!Array.isArray(fields)) return op;
    const kept = fields.filter((entry) => !isDeliveryInputEntry(entry));
    if (kept.length === fields.length) return op;
    stripped = true;
    return { ...op, inputs: { ...inputs, fields: kept } };
  });
  if (!stripped) return artifact;
  return { ...artifact, operations: mapped } as CompileArtifact;
}

/** C3: true only for the L3 loader's delivery-kind whole-set rejection. */
function isDeliveryKindRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as { name?: unknown }).name !== "IncompatibleArtifactError") return false;
  if ((err as { reason?: unknown }).reason !== "unknown_input_kind") return false;
  return err.message.includes('"delivery"');
}

/**
 * R01: contract-level default kinds (`contracts/state.ts`
 * `CanonicalFieldDef.default`). Inline literals with a cite, not a
 * second vocabulary: the state loader owns default semantics
 * (serializability, dot-paths); this checks membership only.
 * DELETE THIS with the C3 strip (B-loader-tolerance).
 */
const R01_CONTRACT_DEFAULT_KINDS: ReadonlySet<string> = new Set([
  "literal",
  "parent",
  "server",
  "derived",
]);

/**
 * R01: validate every delivery entry the C3 strip is about to drop,
 * BEFORE the stripped retry. The loader's kind gate precedes its
 * envelope checks, so without this a malformed additive envelope on
 * a delivery input (bad `required`, bad `array` marker, misshapen
 * `default`) is silently dropped and the set loads — bypassing
 * whole-set rejection. Non-delivery entries need no envelope
 * pre-check: the stripped retry validates them fully (name
 * uniqueness is the exception — see
 * `assertOriginalInputNameUniqueness`, which must run over the
 * FULL original list because the strip erases collisions).
 *
 * Owning envelope semantics in loader vocabulary (`required`
 * boolean, `array` marker, FULL ordinary `default` validation
 * mirroring the registry's `checkDefault`/`checkLoadDotPath`,
 * non-empty name — the registry gates the retry would otherwise
 * skip past the kind gate, plus the name gate for delivery entries
 * ordered after the first): failures throw the loader's OWN
 * rejection class with its message vocabulary, indistinguishable
 * from a loader rejection. Delivery-descriptor internals
 * (capability/version fencing) stay with B-loader-tolerance —
 * dropped entries never execute.
 * DELETE THIS with the C3 strip.
 */
function assertDroppedDeliveryEnvelopes(
  producers: CanonicalStateProducers,
  artifact: CompileArtifact,
): void {
  const fail = (reason: string, message: string): never => {
    throw new producers.registry.IncompatibleArtifactError(reason, message);
  };
  const operations = (artifact as unknown as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return;
  for (const op of operations) {
    if (!isUnknownRecord(op)) continue;
    const inputs: unknown = op["inputs"];
    if (!isUnknownRecord(inputs)) continue;
    const fields: unknown = inputs["fields"];
    if (!Array.isArray(fields)) continue;
    const opName: unknown = op["name"];
    for (const entry of fields) {
      if (!isDeliveryInputEntry(entry)) continue;
      const record = entry as Record<string, unknown>;
      const name: unknown = record["name"];
      if (typeof name !== "string" || name === "") {
        fail(
          "malformed_descriptor",
          `Invalid artifact operation ${JSON.stringify(opName)}: inputs need non-empty names.`,
        );
      }
      const what = `input ${JSON.stringify(name)} on operation ${JSON.stringify(opName)}`;
      if (typeof record["required"] !== "boolean") {
        fail("malformed_descriptor", `Invalid ${what}: required must be a boolean.`);
      }
      const fallback: unknown = record["default"];
      if (fallback !== undefined) {
        if (!isUnknownRecord(fallback) || typeof fallback["kind"] !== "string") {
          fail("malformed_descriptor", `Invalid default for ${what}: a default object needs a kind.`);
        }
        const fallbackRecord = fallback as Record<string, unknown>;
        const kind = fallbackRecord["kind"] as string;
        if (!R01_CONTRACT_DEFAULT_KINDS.has(kind)) {
          fail(
            "unknown_default_kind",
            `Unknown default kind ${JSON.stringify(kind)} for ${what}; ` +
              "supported: literal, parent, server, derived.",
          );
        }
        // Owning default semantics (registry `checkDefault`, same
        // order, same vocabulary): literal values must be
        // serializable data; parent paths must be valid dot-paths
        // (registry `checkLoadDotPath`: non-empty, no empty
        // segments); server/derived carry no payload.
        if (kind === "literal") {
          try {
            structuredClone(fallbackRecord["value"]);
          } catch {
            fail(
              "malformed_descriptor",
              `Invalid literal default for ${what}: values must be serializable data.`,
            );
          }
        }
        if (kind === "parent") {
          if (typeof fallbackRecord["path"] !== "string") {
            fail("malformed_descriptor", `Invalid parent default for ${what}: path must be a dot-path string.`);
          }
          const dotPath = fallbackRecord["path"] as string;
          if (dotPath === "" || dotPath.split(".").some((segment) => segment === "")) {
            fail("malformed_descriptor", `Invalid parent default for ${what} dot path: ${JSON.stringify(dotPath)}.`);
          }
        }
      }
      const array: unknown = record["array"];
      if (array !== undefined) {
        if (!isUnknownRecord(array) || typeof array["required"] !== "boolean") {
          fail("malformed_descriptor", `Invalid ${what}: array markers carry a boolean required.`);
        }
      }
    }
  }
}

/**
 * R01-residual: name uniqueness over the FULL original per-op input
 * list, BEFORE the C3 strip drops delivery entries. The loader
 * checks names/duplicates before the kind gate per entry — but it
 * fails fast at the FIRST delivery-kind entry, so collisions at or
 * after that entry never surface on the full load, and the strip
 * then erases the delivery side of the collision (delivery/string
 * in delivery-first order, delivery/delivery). Entries without a
 * usable name are skipped here: delivery ones fail the envelope
 * name gate, retained ones fail on the stripped retry — either
 * way before any load succeeds. Runs BEFORE the envelope
 * validation, mirroring the loader's per-entry gate order
 * (name/duplicate precede envelope checks). Loader's OWN rejection
 * class + `duplicate_name` vocabulary.
 * DELETE THIS with the C3 strip.
 */
function assertOriginalInputNameUniqueness(
  producers: CanonicalStateProducers,
  artifact: CompileArtifact,
): void {
  const operations = (artifact as unknown as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return;
  for (const op of operations) {
    if (!isUnknownRecord(op)) continue;
    const inputs: unknown = op["inputs"];
    if (!isUnknownRecord(inputs)) continue;
    const fields: unknown = inputs["fields"];
    if (!Array.isArray(fields)) continue;
    const seen = new Set<string>();
    for (const entry of fields) {
      if (!isUnknownRecord(entry)) continue;
      const name: unknown = entry["name"];
      if (typeof name !== "string" || name === "") continue;
      if (seen.has(name)) {
        throw new producers.registry.IncompatibleArtifactError(
          "duplicate_name",
          `Duplicate input ${JSON.stringify(name)} on operation ` +
            `${JSON.stringify(op["name"])}.`,
        );
      }
      seen.add(name);
    }
  }
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
 *
 * C3: the L3 load runs against the full artifact first; ONLY on the
 * loader's delivery-kind rejection it retries once with delivery op
 * inputs stripped (see `stripDeliveryInputs`) — delivery is
 * dispatch-layer only, so the stripped descriptors are exactly what
 * L3 executes. Any other rejection propagates verbatim.
 *
 * R01: before the stripped retry, the FULL original input list
 * proves name uniqueness (`assertOriginalInputNameUniqueness` —
 * the strip would erase delivery-side collisions) and every
 * to-be-dropped delivery entry proves its envelope
 * (`assertDroppedDeliveryEnvelopes`) — the loader's kind gate
 * precedes its envelope checks, so the retry would otherwise
 * launder malformed additives into acceptance. Whole-set
 * rejection preserved.
 */
/** Machine support belongs to the installed producer, independently of the stable state contract. */
export function assertStateMachineProducerCapability(artifact: CompileArtifact, catalog: unknown): void {
  const requirement = artifact.requires.find((entry) => entry.capability === "state.machines");
  const carriesMachine = artifact.models?.some((model) => model.fields.some((field) => field.machine !== undefined)) ?? false;
  if (!carriesMachine && requirement === undefined) return;
  if (requirement === undefined || requirement.min_version < 1) throw new Error("state.machines capability is required for machine fields.");
  const capabilities = isUnknownRecord(catalog) ? catalog["capabilities"] : undefined;
  const provided = isUnknownRecord(capabilities) ? capabilities["state.machines"] : undefined;
  if (typeof provided !== "number" || provided < requirement.min_version) {
    throw new Error("Installed state producer does not provide the required state.machines capability.");
  }
}

export async function loadCanonicalDescriptors(
  asm: AssembledModules,
  artifact: CompileArtifact,
): Promise<LoadedCanonicalDescriptors> {
  const cached = canonicalCache.get(artifact);
  if (cached !== undefined) return cached;
  if (artifact.requires.some((entry) => entry.capability === "state.machines") ||
      artifact.models?.some((model) => model.fields.some((field) => field.machine !== undefined))) {
    const catalogMod = await loadProducerModule("@canlang/state/catalog", "state capability catalog");
    const catalog = requireProducerFn(catalogMod, "stateCatalog", "state capability catalog")();
    assertStateMachineProducerCapability(artifact, catalog);
  }
  const producers = await loadCanonicalStateProducers();
  const ops = readPreloadOperations(artifact);
  const crudBy = new Map<string, CanonicalByPredicate>();
  for (const op of ops) {
    if (op.kind === "create" || op.kind === "update" || op.kind === "delete") {
      const callable = resolvePreloadCallable(artifact, op);
      const registry = await importPolicyRegistry(asm, callable.module, op.name);
      crudBy.set(op.name, mapCrudPolicyToBy(op.name, readOperationPolicyEntry(registry, op.name)));
    } else if (op.kind === "scenario") {
      // B7: scenarios join admission transcription (absent -> deny;
      // their leading require guards stay handler-enforced inside).
      const callable = resolvePreloadCallable(artifact, op);
      const registry = await importPolicyRegistry(asm, callable.module, op.name);
      crudBy.set(op.name, mapScenarioPolicyToBy(op.name, readOperationPolicyEntry(registry, op.name)));
    }
  }
  const byOptions = {
    by: (op: { kind: string; name: string }) => {
      if (op.kind === "create" || op.kind === "update" || op.kind === "delete" || op.kind === "scenario") {
        const predicate = crudBy.get(op.name);
        if (predicate === undefined) {
          throw new Error(
            `t16b: operation ${JSON.stringify(op.name)} reached admission without a ` +
              `transcribed gate (loader/artifact skew?)`,
          );
        }
        return predicate;
      }
      // Reads admit `public` at the gate (T17b read-by posture: keep
      // public + grants — visibility comes from the transcribed
      // PolicyTable, and `invokeRead` serves them). B7: deny-with-empty
      // comes from zero grants, so the gate stays public.
      return "public";
    },
  };
  let loaded: ReturnType<typeof producers.registry.loadArtifactDescriptors>;
  try {
    loaded = producers.registry.loadArtifactDescriptors(artifact, byOptions);
  } catch (err) {
    if (!isDeliveryKindRejection(err)) throw err;
    // R01: validate-before-retry — the FULL original input list
    // proves name uniqueness first (the strip would erase
    // collisions), then dropped delivery entries prove their
    // envelopes before the strip drops the evidence.
    assertOriginalInputNameUniqueness(producers, artifact);
    assertDroppedDeliveryEnvelopes(producers, artifact);
    loaded = producers.registry.loadArtifactDescriptors(stripDeliveryInputs(artifact), byOptions);
  }
  const table = producers.models.buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
    containment: loaded.containment,
  });
  // T17b: transcribe the read policy over the LOADED models (validated
  // names + declared fields — never the raw artifact). Ruled models are
  // omitted from the table (fail-closed even under a missed check) and
  // recorded for serve-time refusal; the builder validates every input.
  const modelFields = new Map(loaded.models.map((model, index) => {
    const name = canonicalModelName(model, index);
    return [name, canonicalModelFields(model, `loaded model ${JSON.stringify(name)}`)] as const;
  }));
  const manifests = await collectModelPolicyManifests(asm, modelFields);
  const policyInputs: CanonicalModelPolicyInput[] = [];
  const ruledModels = new Set<string>();
  for (const [index, model] of loaded.models.entries()) {
    const name = canonicalModelName(model, index);
    const manifest = manifests.get(name);
    if (!(loaded.secretFields instanceof Map) || !loaded.secretFields.has(name)) {
      throw new Error(`t17b: model ${JSON.stringify(name)} installed State producer lacks typed-secret metadata.`);
    }
    const transcribed = transcribeReadFacts(
      name,
      manifest?.policy ?? {},
      modelFields.get(name)!,
      [...loaded.secretFields.get(name)!],
      manifest?.selectors,
    );
    if (transcribed.ruled) {
      ruledModels.add(name);
    } else if (transcribed.input !== null) {
      policyInputs.push(transcribed.input);
    }
  }
  const policy = producers.grants.buildPolicyTable(policyInputs);
  const collectionColumns = new Map<string, readonly ColumnMeta[]>();
  for (const [index, model] of loaded.models.entries()) {
    const name = canonicalModelName(model, index);
    const fields = (model as Record<string, unknown>)["fields"] as Record<string, unknown>;
    const secrets = loaded.secretFields.get(name)!;
    collectionColumns.set(name, Object.keys(fields).filter(field => !secrets.has(field)).flatMap(field => {
      const type = manifests.get(name)?.fieldTypes.get(field);
      return type === undefined ? [] : [{ field, label: field, type }];
    }));
  }
  const canonical: LoadedCanonicalDescriptors = {
    registry: loaded.registry,
    table,
    policy,
    ruledModels,
    collectionColumns,
    producers,
    conflictServerOnly: buildConflictServerOnly(loaded.models),
    deliveryFields: loaded.deliveryFields,
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
        if (typeof first.expectedVersion !== "number") {
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
        collapsed.push({ kind: "insert", model: first.model, row: { ...finalRow, version: 1 as RecordVersion } });
      } else {
        if (typeof first.expectedVersion !== "number") {
          throw new Error(`t17b: staged ${first.kind} lost its expectedVersion (pipeline/dist skew?)`);
        }
        collapsed.push({
          kind: "update",
          model: first.model,
          id,
          expectedVersion: first.expectedVersion,
          row: { ...finalRow, version: (first.expectedVersion + 1) as RecordVersion },
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
      if (typeof first.expectedVersion !== "number") {
        throw new Error(`t17b: staged ${first.kind} lost its expectedVersion (pipeline/dist skew?)`);
      }
      collapsed.push({
        kind: "remove",
        model: first.model,
        id,
        expectedVersion: first.expectedVersion,
      });
    }
    collapsed.push({ kind: "insert", model: first.model, row: { ...finalRow, version: 1 as RecordVersion } });
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
function snapshotCallerRoles(grants: ReadonlyArray<string>, owner: boolean): string {
  return JSON.stringify([[...grants].sort(), owner]);
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
  return snapshotCallerRoles(membership.roles.map((grant) => grant.role), membership.is_owner);
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
/** Clone admitted snapshots so handlers cannot mutate admission evidence or stored rows. */
function scenarioParameters(call: CanonicalSeamCall, artifact: CompileArtifact, staged: Map<string, StoredRow | null>): Record<string, unknown> {
  const parameters = structuredClone(call.inputs);
  const views = new Map<string, object>();
  for (const ref of call.recordRefs ?? []) {
    const row = ref.row;
    const key = stagedKey(ref.model, row.id);
    let view = views.get(key);
    if (view === undefined) {
      const admitted = freezeScenarioSnapshot(structuredClone(row.data)) as Record<string, unknown>;
      const fields = artifact.models?.find((model) => model.name === ref.model)?.fields.map((field) => field.name) ?? Object.keys(row.data);
      const record: Record<string, unknown> = {};
      for (const field of fields) Object.defineProperty(record, field, {
        enumerable: true, get: () => staged.has(key) ? staged.get(key)?.data[field] : admitted[field],
      });
      Object.assign(record, { id: row.id, version: BigInt(row.version), created: new Date(row.created).toISOString(),
        updated: new Date(row.updated).toISOString(), created_by: row.createdBy, updated_by: row.updatedBy,
        archived_at: row.archivedAt === null ? null : new Date(row.archivedAt).toISOString(),
      });
      view = Object.freeze(record);
      views.set(key, view);
    }
    parameters[ref.param] = view;
  }
  return parameters;
}
function freezeScenarioSnapshot(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeScenarioSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

async function runScenarioSeam(
  loaded: LoadedCanonicalDescriptors,
  opts: CanonicalMutationOpts,
  call: CanonicalSeamCall,
): Promise<CanonicalExecutionEffects> {
  const actorUserId = call.context.actor?.userId ?? null;
  const teamId = call.context.team?.teamId ?? null;
  let grants: string[] = [];
  const builtinRoles = ["public", ...(actorUserId === null ? [] : ["authenticated"])];
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
      callerRolesSnapshot = snapshotCallerRoles(grants, membership.is_owner);
      builtinRoles.push("members");
      if (membership.is_owner) builtinRoles.push("owner");
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
  const reservedVersions = new Map<string, RecordVersion>();
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
      const stagedRow = freezeScenarioSnapshot(structuredClone(row)) as StoredRow;
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
    builtinRoles: Object.freeze(builtinRoles),
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
              ...(write.transition === undefined ? {} : { transition: write.transition }),
            },
          ],
          context: call.context,
          store: overlay,
          // C2/B1: admission-parity archive gate (CRUD inherits it from
          // admission; scenario writes bypass per-write admission).
          gateArchivedTargets: true,
          // T32b: the triggering checkpoint point — hook bodies name it
          // back as their `triggerRevision` when they open fresh
          // transitive scopes. Absent on checkpoint-less calls.
          ...(seamTrigger === undefined ? {} : { trigger: seamTrigger }),
        });
        const normalizedWrites = result.writes.map((touch) => {
          const id = touch.kind === "insert" ? touch.row?.id : touch.id;
          if (typeof id !== "string") throw new Error("staged write lost record identity");
          const key = stagedKey(touch.model, id);
          if (touch.kind === "insert") reservedVersions.set(key, 1 as RecordVersion);
          else if (!reservedVersions.has(key) && typeof touch.expectedVersion === "number") {
            reservedVersions.set(key, (touch.expectedVersion + 1) as RecordVersion);
          }
          const version = reservedVersions.get(key);
          return touch.row === undefined || version === undefined ? touch : { ...touch, row: { ...touch.row, version } };
        });
        const first = normalizedWrites[0];
        if (first === undefined) {
          throw new Error(`t17b: pipeline staged no write for one submitted write (pipeline/dist skew?)`);
        }
        stagedWrites.push(...normalizedWrites);
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
        for (const stagedWrite of normalizedWrites) {
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
  const admittedNow = call.context.now;
  const ctx = createContext({
    caller:
      actorUserId === null
        ? { userId: "anonymous", roles: [] }
        : { userId: actorUserId, roles: grants },
    store: withCanonicalCommitGuard(overlay, opts.operation),
    clock: () => admittedNow,
    memberships: grants,
    canonical: scope,
    qualified: call.context,
  });
  const callable = opts.artifact.callables.find((entry) => entry.id === opts.operation);
  const argument = callable?.inputStyle === "parameters"
    ? scenarioParameters(call, opts.artifact, staged)
    : { operation_id: call.context.operationId, inputs: call.inputs };
  const outcome = await invokeWith(opts.asm, opts.artifact, opts.operation, ctx, [argument]);
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
    history: stagedHistory.map((entry) => {
      if (!isUnknownRecord(entry)) return entry;
      const first = stagedWrites.find((write) => write.model === entry["model"] &&
        (write.kind === "insert" ? write.row?.id : write.id) === entry["recordId"]);
      const version = first?.kind === "insert" ? 1 : typeof first?.expectedVersion !== "number" ? undefined : first.expectedVersion + (first.kind === "remove" ? 0 : 1);
      return version === undefined ? entry : { ...entry, version };
    }),
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
    // C2/B2 (Q3): holder-built exclusions — stale-ref denials carry
    // full currents (minus serverOnly) instead of metadata-only.
    conflictServerOnly: loaded.conflictServerOnly,
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
/* D3b selected-receipt serving (Receipt.read -> T25 join).              */
/*                                                                      */
/* Joint contract (G1 locked): op `Receipt.read`, closed inputs         */
/* {recordId, field, selected[]}, kind:read read-def, MCP-first route,  */
/* revisions as JSON numbers. The serving layer bridges the text-id     */
/* envelope to the join's row-object locator: model binds statically    */
/* from the load-time B3 delivery schema (C1 — never envelope text),    */
/* recordId resolves through the authorized pre-load (existence-hiding */
/* not_found), and the REAL T25 join runs with the REAL work observer  */
/* from the work receipt API. Outcomes serve 1:1 (observed /             */
/* denied-as-data / discriminator-carrying null-association); caller    */
/* errors are `StateError` (assembly maps through `toBusinessError`),   */
/* skew is loud plain `Error`.                                          */
/* ------------------------------------------------------------------ */

/** D3b serving operation (G1-locked joint name). */
export const RECEIPT_READ_OPERATION = "Receipt.read";

const STATE_RECEIPT_JOIN_SPECIFIER = "@canlang/state/receipt/join";
const WORK_RECEIPT_SPECIFIER = "@canlang/work/receipt";
/**
 * Q2: B's worker-safe observer module (SEAM CONTRACT — absent until
 * the B-half lands; F's Q3 rewrite maps it to
 * `vendor/state/receipt/observer.js`).
 */
const STATE_RECEIPT_OBSERVER_SPECIFIER = "@canlang/state/receipt";

/**
 * D3b: 1:1 served selected-receipt outcome (E wire-half contract).
 * Revisions are JSON numbers (G4). `denied` is DATA (which leaves
 * were withheld), never an error; `null-association` carries the
 * discriminator so it never masquerades as denial.
 */
export type SelectedReceiptServed =
  | {
      readonly outcome: "observed";
      readonly projection: SelectedReceiptProjection;
      readonly fenceRevision: number | null;
      readonly readRevision: number;
    }
  | {
      readonly outcome: "denied";
      readonly denied: ReadonlyArray<ReceiptProperty>;
      readonly readRevision: number;
    }
  | { readonly outcome: "null-association"; readonly readRevision: number };

/**
 * D3b: per-call owner-fence handle (structural mirror of the engine
 * `FenceScope` — only the revision + record enrollment the serving
 * path touches). Standalone served reads take NO fence (B openQ_fence
 * answered: fenceless + reported readRevision); nested callers thread
 * theirs and the pre-load enrolls the owner row in it (B C3).
 */
export interface SelectedReceiptFence {
  readonly revision: number;
  enroll(dependency: {
    readonly kind: "record";
    readonly model: string;
    readonly id: string;
    readonly version: number;
  }): void;
}

/**
 * Q2: injected production observer (per-call binding, mirroring the
 * `invokeReadCanonical` pattern). When present, serving uses it
 * directly and touches NEITHER the observer module NOR the
 * work receipt-loader leg — the production leg without B's module landed.
 */
export interface SelectedReceiptObserverBinding {
  readonly observeSelectedReceipt: (input: unknown) => unknown;
}

export interface SelectedReceiptReadOpts {
  readonly asm: AssembledModules;
  readonly artifact: CompileArtifact;
  /** Q2: injected observer wins over module resolution (production leg). */
  readonly observer?: SelectedReceiptObserverBinding;
  /** Must be `Receipt.read` (routing assert — skew tripwire otherwise). */
  readonly operation: string;
  readonly inputs: Record<string, unknown>;
  /** Transport-verified identity (resolved from the credential per request). */
  readonly identity: ResolvedIdentity;
  readonly store: StoragePort;
  readonly memberships: CanonicalMembershipReader;
  readonly fence?: SelectedReceiptFence;
  readonly now?: () => number;
}

/** D3b: structural view of the state receipt-join module (input/output mirrors only what serving touches). */
interface StateReceiptJoinProducer {
  observeSelectedReceiptJoin(input: {
    readonly locator: { readonly record: { readonly id: string }; readonly field: string };
    readonly selected: ReadonlyArray<string>;
    readonly model: string;
    readonly schema: ReadonlyMap<string, ReadonlySet<string>>;
    readonly policy: unknown;
    readonly caller: { readonly actorUserId: string | null; readonly teamId: string | null };
    readonly memberships: CanonicalMembershipReader;
    readonly store: StoragePort;
    readonly fence?: SelectedReceiptFence;
    readonly nowMs: number;
    readonly observeSelected: (input: unknown) => unknown;
  }): Promise<unknown>;
}

/** D3b: structural view of the declared work receipt-loader API. */
interface StateReceiptWorkLoaderProducer {
  loadWorkReceiptFns(): Promise<{
    readonly observeSelectedReceipt: (input: unknown) => unknown;
  }>;
}

/**
 * Q2 SEAM CONTRACT (B-half input — see
 * `implementation/D3B-OBSERVER-SEAM-CONTRACT.md`): structural view of
 * B's worker-safe observer module
 * (`packages/state/src/receipt/observer.ts`, zero node imports).
 * Same observer shape as the work-loader leg, new module + loader
 * name so production never touches the TEST-ONLY bridge.
 */
export interface StateReceiptObserverProducer {
  loadSelectedReceiptObserver(): Promise<SelectedReceiptObserverBinding>;
}

const RECEIPT_READ_INPUT_KEYS: ReadonlyArray<string> = ["recordId", "field", "selected"];

const RECEIPT_LEAVES: ReadonlySet<string> = new Set(["id", "status", "result", "error"]);

const RECEIPT_PROJECTION_KEYS: ReadonlySet<string> = new Set(["id", "status", "result", "error"]);

/**
 * D3b: validate the closed serving envelope (C1 + C7). Exactly
 * {recordId, field, selected} — a `model` key rejects explicitly
 * (bound server-side, never trusted), every other unknown key
 * rejects as unclosed. Kernel TypeError/RangeError classes are
 * unreachable past this point by construction (same accept/reject
 * table, thrown as `StateError` validation here instead).
 */
function assertReceiptReadInputs(
  StateError: StateErrorsProducer,
  inputs: Record<string, unknown>,
): { readonly recordId: string; readonly field: string; readonly selected: ReceiptProperty[] } {
  for (const key of Object.keys(inputs)) {
    if (key === "model") {
      throw new StateError(
        "validation",
        `Receipt.read must not carry model (bound server-side from the delivery schema).`,
      );
    }
    if (!RECEIPT_READ_INPUT_KEYS.includes(key)) {
      throw new StateError(
        "validation",
        `Receipt.read inputs must be exactly {recordId, field, selected} (unknown key ${JSON.stringify(key)}).`,
      );
    }
  }
  const recordId: unknown = inputs["recordId"];
  if (typeof recordId !== "string" || recordId === "") {
    throw new StateError("validation", `Receipt.read recordId must be a non-empty string.`);
  }
  const field: unknown = inputs["field"];
  if (typeof field !== "string" || field === "") {
    throw new StateError("validation", `Receipt.read field must be a non-empty plain name.`);
  }
  if (field.includes(".") || field.includes("[") || field.includes("]")) {
    throw new StateError("validation", `Receipt.read field must be a plain name, never traversal.`);
  }
  const selected: unknown = inputs["selected"];
  if (!Array.isArray(selected)) {
    throw new StateError("validation", `Receipt.read selected must be an array.`);
  }
  if (selected.length === 0) {
    throw new StateError("validation", `Receipt.read selected must not be empty.`);
  }
  for (const property of selected) {
    if (typeof property !== "string" || !RECEIPT_LEAVES.has(property)) {
      throw new StateError(
        "validation",
        `Receipt.read selected carries unknown property ${JSON.stringify(String(property))}.`,
      );
    }
  }
  return { recordId, field, selected: [...(selected as string[])] as ReceiptProperty[] };
}

/**
 * D3b: bind the owning model statically from the load-time B3
 * delivery schema (C1/C2 — the serving operation's binding, never
 * envelope text). Zero declarers is an undeclared field; multiple
 * declarers is ambiguous — both refuse loud as caller validation
 * (fail-closed; recordIds are model-scoped, never probed across).
 */
function bindReceiptModel(
  StateError: StateErrorsProducer,
  deliveryFields: ReadonlyMap<string, ReadonlySet<string>>,
  field: string,
): string {
  const declarers: string[] = [];
  for (const [model, fields] of deliveryFields.entries()) {
    if (fields.has(field)) declarers.push(model);
  }
  if (declarers.length === 0) {
    throw new StateError(
      "validation",
      `Receipt.read field ${JSON.stringify(field)} is not a declared delivery field.`,
    );
  }
  if (declarers.length > 1) {
    throw new StateError(
      "validation",
      `Receipt.read field ${JSON.stringify(field)} is declared by multiple models; cannot bind.`,
    );
  }
  return declarers[0] as string;
}

/**
 * D3b: route through the server-side read descriptor (C1 — the routed
 * op descriptor anchors routing + admission). Unknown operations
 * reject with the engine's exact text; a present-but-wrong def
 * (non-read kind, non-public gate, row predicate) is loader skew —
 * loud, never admitted or mis-served. The public gate admits all
 * (engine `evaluateBy` returns true for `public`); visibility comes
 * from leaf grants (denied-as-data), never the gate.
 */
function assertReceiptReadDef(
  StateError: StateErrorsProducer,
  registry: ReadonlyMap<string, unknown>,
): void {
  const def: unknown = registry.get(RECEIPT_READ_OPERATION);
  if (def === undefined) {
    throw new StateError("validation", `Unknown operation "${RECEIPT_READ_OPERATION}".`);
  }
  if (!isUnknownRecord(def) || def["generated"] !== true) {
    throw new Error(`d3b: Receipt.read def is not a generated def (loader/artifact skew?)`);
  }
  const descriptor: unknown = def["descriptor"];
  if (!isUnknownRecord(descriptor) || descriptor["kind"] !== "read") {
    throw new Error(`d3b: Receipt.read def is not a read def (loader/artifact skew?)`);
  }
  if (def["by"] !== "public") {
    throw new Error(`d3b: Receipt.read gate is not public (loader skew?)`);
  }
  if (def["when"] !== undefined) {
    throw new Error(`d3b: Receipt.read def carries a row predicate (unsupported)`);
  }
}

/**
 * D3b: reserved-name collision guard. An app model named `Receipt`
 * plus a `Receipt.read` read op would silently hijack model serving
 * into receipt serving (or vice versa) — refuse loud instead. Static
 * per artifact (deployment bug class), checked per call.
 */
function assertNoReceiptModelCollision(artifact: CompileArtifact): void {
  const models: unknown = (artifact as unknown as { models?: unknown }).models;
  if (!Array.isArray(models)) return;
  for (const model of models) {
    if (isUnknownRecord(model) && model["name"] === "Receipt") {
      throw new Error(
        `d3b: artifact declares both model "Receipt" and operation "Receipt.read" (reserved collision?)`,
      );
    }
  }
}

/**
 * D3b: map the join outcome 1:1 onto the served shape (G4: revisions
 * are JSON numbers). Unknown discriminators, misshapen projections,
 * and non-numeric revisions are mechanism skew — loud, never served.
 */
export function mapReceiptJoinOutcome(outcome: unknown): SelectedReceiptServed {
  if (!isUnknownRecord(outcome) || typeof outcome["outcome"] !== "string") {
    throw new Error(`d3b: join served no outcome discriminator (invoke/dist skew?)`);
  }
  const readRevision: unknown = outcome["readRevision"];
  if (typeof readRevision !== "number") {
    throw new Error(`d3b: join served a non-numeric readRevision (invoke/dist skew?)`);
  }
  const discriminator: string = outcome["outcome"] as string;
  if (discriminator === "observed") {
    const projection: unknown = outcome["projection"];
    if (!isUnknownRecord(projection)) {
      throw new Error(`d3b: join served a non-object projection (invoke/dist skew?)`);
    }
    for (const key of Object.keys(projection)) {
      if (!RECEIPT_PROJECTION_KEYS.has(key)) {
        throw new Error(`d3b: join served unknown projection key ${JSON.stringify(key)} (skew?)`);
      }
    }
    const fenceRevision: unknown = outcome["fenceRevision"];
    if (fenceRevision !== null && (typeof fenceRevision !== "number" || !Number.isInteger(fenceRevision) || fenceRevision < 0)) {
      throw new Error(`d3b: join served a non-numeric fenceRevision (invoke/dist skew?)`);
    }
    return {
      outcome: "observed",
      projection: projection as unknown as SelectedReceiptProjection,
      fenceRevision: fenceRevision as number | null,
      readRevision,
    };
  }
  if (discriminator === "denied") {
    const denied: unknown = outcome["denied"];
    if (
      !Array.isArray(denied) ||
      denied.length === 0 ||
      !denied.every((leaf: unknown) => typeof leaf === "string" && RECEIPT_LEAVES.has(leaf))
    ) {
      throw new Error(`d3b: join served a malformed denied set (invoke/dist skew?)`);
    }
    return { outcome: "denied", denied: [...(denied as string[])] as ReceiptProperty[], readRevision };
  }
  if (discriminator === "null-association") {
    return { outcome: "null-association", readRevision };
  }
  throw new Error(`d3b: join served unknown outcome ${JSON.stringify(discriminator)} (skew?)`);
}

/**
 * D3b: serve one `Receipt.read` through the REAL T25 join with the
 * REAL work observer (loaded per call via the work receipt API —
 * bound per call, never cached, the `invokeReadCanonical` pattern).
 *
 * Evaluation order (B C4 + the join's own order): routed read-def
 * (C1) -> closed envelope (C1/C7) -> field+model binding (C2) ->
 * fence-join revision read (conflict when a nested checkpoint moved)
 * -> owner pre-load (not_found) -> grant authZ (existence-hiding
 * not_found — identical text, so denied-vs-missing never leaks) ->
 * nested pre-load enrollment (B C3) -> the join (locator contributes
 * ONLY the string id — the join re-loads the CURRENT row) -> 1:1
 * outcome mapping. Reads commit nothing and receipt nothing. Caller
 * errors are `StateError`; skew is loud plain `Error`.
 *
 * Q2 observer resolution (ordered, loud at the end): an injected
 * `opts.observer` wins outright (production leg / assembly binding);
 * else B's worker-safe observer module once it lands + F
 * vendors/rewrites it; else — absent-module ONLY — the TEST-ONLY
 * work receipt-loader API (installed Node tooling until then). A present-but-broken
 * observer (eval throw, missing export, loader/shape failure) is
 * loud, never masked by the fallback (D1). When NEITHER module
 * resolves — the worker before the B+F halves — the work receipt-loader
 * leg throws its existing loud t16b error: refusal, never silent.
 */
/**
 * Q2-D1: true ONLY when an observer-module import failed because the
 * module itself is absent (B-half not landed / not vendored). Node
 * reports the missing specifier in `Cannot find module '<missing>'`;
 * the match anchors on the MISSING module being exactly
 * `receipt/observer.js` (N-R1: a bare `observer.js` anchor would
 * also match a same-named file in another directory). A nested
 * missing dep inside a present observer.js names the nested path
 * (observer.js appears only as the importer) and reads as
 * broken-B, never absent. Unknown shapes (workerd misses) read as
 * broken: fail-closed loud, never a masking fallback.
 */
export function isObserverModuleAbsent(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record["code"] !== "ERR_MODULE_NOT_FOUND") return false;
  const message = record["message"];
  if (typeof message !== "string") return false;
  return /^Cannot find module '[^']*receipt\/observer\.js'/.test(message);
}

async function resolveReceiptObserver(
  injected: SelectedReceiptReadOpts["observer"],
): Promise<(input: unknown) => unknown> {
  if (injected !== undefined) return injected.observeSelectedReceipt;
  // Presence probe: absent-module ONLY falls back to the work receipt-loader
  // leg. A present-but-broken observer (eval throw, missing export,
  // loader/shape failure) stays loud below — broken B is never
  // masked by the fallback.
  const receiptMod = await loadProducerModule(STATE_RECEIPT_OBSERVER_SPECIFIER, "state receipt producer");
  const loadReceiptObserver = requireProducerFn(receiptMod, "loadReceiptObserver", "state receipt producer");
  let observerMod: Record<string, unknown>;
  try {
    observerMod = await loadReceiptObserver() as Record<string, unknown>;
  } catch (error) {
    if (!isObserverModuleAbsent(error)) throw error;
    const loaderMod = await loadProducerModule(
      WORK_RECEIPT_SPECIFIER,
      "work receipt producer",
    );
    const loadWorkReceiptFns = requireProducerFn(
      loaderMod,
      "loadWorkReceiptFns",
      "work receipt producer",
    ) as unknown as StateReceiptWorkLoaderProducer["loadWorkReceiptFns"];
    const { observeSelectedReceipt } = await loadWorkReceiptFns();
    return observeSelectedReceipt;
  }
  const loadSelectedReceiptObserver = requireProducerFn(
    observerMod,
    "loadSelectedReceiptObserver",
    "state receipt observer producer",
  ) as unknown as StateReceiptObserverProducer["loadSelectedReceiptObserver"];
  const { observeSelectedReceipt } = await loadSelectedReceiptObserver();
  if (typeof observeSelectedReceipt !== "function") {
    throw new Error(`t16b: state receipt observer producer served no observeSelectedReceipt function`);
  }
  return observeSelectedReceipt as (input: unknown) => unknown;
}

export async function invokeSelectedReceiptRead(
  opts: SelectedReceiptReadOpts,
): Promise<SelectedReceiptServed> {
  if (opts.operation !== RECEIPT_READ_OPERATION) {
    throw new Error(`d3b: receipt serving routed operation ${JSON.stringify(opts.operation)} (skew?)`);
  }
  assertCanonicalStore(opts.store, opts.operation);
  assertCanonicalMemberships(opts.memberships, opts.operation);
  assertNoReceiptModelCollision(opts.artifact);
  const loaded = await loadCanonicalDescriptors(opts.asm, opts.artifact);
  const StateError = loaded.producers.errors;
  assertReceiptReadDef(StateError, loaded.registry);
  const { recordId, field, selected } = assertReceiptReadInputs(StateError, opts.inputs);
  const model = bindReceiptModel(StateError, loaded.deliveryFields, field);
  // Fence-join revision FIRST (C4): no grant or observation runs
  // before this read; a moved nested checkpoint conflicts here, and
  // the join re-checks against its own read below.
  const fenceReadRevision = await opts.store.readRevision();
  if (opts.fence !== undefined && opts.fence.revision !== fenceReadRevision) {
    throw new StateError(
      "conflict",
      `Fence checkpoint moved before this read (enrolled at revision ${opts.fence.revision}, ` +
        `now at ${fenceReadRevision}); re-fence the operation.`,
    );
  }
  const owner = await opts.store.load(model as ModelName, recordId as RecordId);
  if (owner === null) {
    throw new StateError("not_found", "Receipt owner record not found.");
  }
  // Caller facts mirror the engine admit mapping verbatim (B C6):
  // nulls when absent, live membership resolution both ways.
  const actorUserId = opts.identity.actor === null ? null : opts.identity.actor.user_id;
  const teamId = opts.identity.team === null ? null : opts.identity.team.team_id;
  const membership =
    actorUserId !== null && teamId !== null
      ? await opts.memberships.findMembership(teamId, actorUserId)
      : null;
  const policyTable = loaded.policy as ReadonlyMap<string, unknown>;
  const modelPolicy: unknown = policyTable.get(model);
  if (modelPolicy !== undefined) {
    if (!isUnknownRecord(modelPolicy) || !Array.isArray(modelPolicy["grants"])) {
      throw new Error(`d3b: owner policy entry is not a grant list (loader skew?)`);
    }
    const matched = await loaded.producers.grants.matchGrants(
      modelPolicy as { readonly grants: ReadonlyArray<{ readonly by: unknown; readonly when?: unknown }> },
      { actorUserId, teamId, membership, memberships: opts.memberships },
      owner,
    );
    if (!Array.isArray(matched)) {
      throw new Error(`d3b: matchGrants served no grant array (invoke/dist skew?)`);
    }
    if (matched.length === 0) {
      // Authorized-path miss: identical text to the missing row
      // (existence-hiding — denied-vs-missing must never leak).
      throw new StateError("not_found", "Receipt owner record not found.");
    }
  } else {
    // No policy entry grants nothing (engine precedent: deny, never
    // error) — identical text, same hiding.
    throw new StateError("not_found", "Receipt owner record not found.");
  }
  if (opts.fence !== undefined) {
    opts.fence.enroll({ kind: "record", model, id: owner.id, version: owner.version });
  }
  const joinMod = await loadProducerModule(STATE_RECEIPT_JOIN_SPECIFIER, "state receipt join producer");
  const observeSelectedReceiptJoin = requireProducerFn(
    joinMod,
    "observeSelectedReceiptJoin",
    "state receipt join producer",
  ) as unknown as StateReceiptJoinProducer["observeSelectedReceiptJoin"];
  const observeSelectedReceipt = await resolveReceiptObserver(opts.observer);
  const outcome = await observeSelectedReceiptJoin({
    locator: { record: { id: recordId }, field },
    selected,
    model,
    schema: loaded.deliveryFields,
    policy: loaded.policy,
    caller: { actorUserId, teamId },
    memberships: opts.memberships,
    store: opts.store,
    ...(opts.fence === undefined ? {} : { fence: opts.fence }),
    nowMs: (opts.now ?? Date.now)(),
    observeSelected: observeSelectedReceipt,
  });
  return mapReceiptJoinOutcome(outcome);
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
 * validation, and viewer projection to `invokeRead`. `Receipt.read`
 * instead routes to `invokeSelectedReceiptRead` (D3b join serving;
 * the return widens to the 1:1 outcome — assembly consumes
 * `ReadResult = unknown`, so no worker change). Reads commit
 * nothing and receipt nothing. Throws the canonical `StateError` on
 * business outcomes and plain `Error` on wiring bugs — the assembly
 * maps both through its established `toBusinessError` rule.
 */
export interface CanonicalReadOpts {
  readonly asm: AssembledModules;
  readonly artifact: CompileArtifact;
  readonly operation: string;
  readonly inputs: Record<string, unknown>;
  readonly selection?: CanonicalReadSelection;
  /** Transport-verified identity (resolved from the credential per request). */
  readonly identity: ResolvedIdentity;
  readonly store: StoragePort;
  readonly memberships: CanonicalMembershipReader;
  /**
   * Q2-D2: production observer binding for `Receipt.read` (spread
   * through to `invokeSelectedReceiptRead` — the injection leg is
   * reachable from the canonical read path, not future).
   */
  readonly observer?: SelectedReceiptObserverBinding;
}

export async function invokeReadCanonical(
  opts: CanonicalReadOpts,
): Promise<CanonicalReadServed | SelectedReceiptServed> {
  assertCanonicalStore(opts.store, opts.operation);
  assertCanonicalMemberships(opts.memberships, opts.operation);
  if (opts.operation === RECEIPT_READ_OPERATION) {
    return invokeSelectedReceiptRead({ ...opts });
  }
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
    ...(opts.selection === undefined ? {} : { selection: opts.selection }),
  });
  if (!Array.isArray(served.records)) {
    throw new Error(`t17b: invokeRead served no records array (invoke/dist skew?)`);
  }
  return served;
}

/** Page collections retain generated read admission and the defining viewer executor. */
export async function queryPageRowsCanonical(
  opts: Omit<CanonicalReadOpts, "operation" | "inputs"> & { readonly model: string; readonly args: ListQueryArgs },
): Promise<ListQueryResult> {
  const loaded = await loadCanonicalDescriptors(opts.asm, opts.artifact);
  const StateError = loaded.producers.errors;
  // The outer selection is a plain stable value. State reads these two fields
  // only after generated read admission, live membership and closed inputs.
  const selection: CanonicalReadSelection = {
    get where() {
      if (opts.args.parent !== undefined || opts.args.cursor !== undefined || typeof opts.args.where === "function") {
        throw new StateError("validation", "Page queries do not support parent, cursor or function predicates.");
      }
      return opts.args.where as QueryPredicate;
    },
    get limit() {
      const limit = opts.args.limit ?? COLLECTION_DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_MAX_LIMIT) {
        throw new StateError("validation", "Invalid collection limit.");
      }
      return limit;
    },
  };
  const served = await invokeReadCanonical({ ...opts, operation: `${opts.model}.read`, inputs: {}, selection });
  if (!("records" in served)) throw new Error("page query: canonical model read returned no records");
  // Only authorized projected field names can make a declared column visible.
  // Empty collections expose no field schema; private stored values are never read.
  const visible = new Set(served.records.flatMap(record => Object.keys(record.data)));
  return {
    rows: served.records.map(record => ({ id: record.id, version: String(record.version), fields: record.data })),
    columns: (loaded.collectionColumns.get(opts.model) ?? []).filter(column => visible.has(column.field)),
  };
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
/* arrive through the injected assembly seam; the deploy join supplies */
/* the real producers through work's declared APIs, as tests do.       */
/* Provider calls,                                                     */
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
const STATE_SYSTEM_SPECIFIER = "@canlang/state/ports/system";

/** T32b: state admission module (`openTransitiveScope` for dispatch fences). */
const STATE_ADMISSION_SPECIFIER = "@canlang/state/invocation/admission";

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
  | { readonly status: "refused-revoked" }
  | { readonly status: "unavailable"; readonly outboxId: string; readonly target: string };

/**
 * T32b: fail-closed read of the injected kernel's verdict. `claimed`
 * carries the held claim back (shape-checked; the drive asserts it
 * equals the held claim); `skipped` runs the existing skip ceremony;
 * the two refused statuses return; `unavailable` (D3: the send's
 * deployment target is unavailable — kernel exact-keys shape
 * `{status,outboxId,target}`) carries its target for the transport
 * half (the drive asserts the outbox identity, mirroring
 * `claimed`). Every other status is unreachable by construction —
 * the drive attests a committed pending intent (the claim run just
 * proved pending + non-superseded) — so anything else
 * (superseded/refused-state/refused-uncommitted/unknown) is a loud
 * wiring error, never a silent drive.
 */
function checkFenceAttemptVerdict(value: unknown): FenceAttemptVerdict {
  if (!isUnknownRecord(value) || typeof value["status"] !== "string") {
    throw new Error(`t32b: fence kernel verdict must carry a string status (producer skew?)`);
  }
  const status: string = value["status"];
  if (status === "skipped") return { status };
  if (status === "refused-inherited-scope") return { status };
  if (status === "refused-revoked") return { status };
  if (status === "unavailable") {
    const outboxId: unknown = value["outboxId"];
    const target: unknown = value["target"];
    if (typeof outboxId !== "string" || outboxId === "" || typeof target !== "string" || target === "") {
      throw new Error(`t32b: fence kernel unavailable verdict lost its outboxId/target (producer skew?)`);
    }
    return { status, outboxId, target };
  }
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
    }
  /**
   * D3 transport half (D-routed): the send's deployment target is
   * unavailable (unbound provider, scoped-out capability) — the
   * kernel refused BEFORE guard evaluation and the drive maps the
   * verdict here with the echoed target. Terminal and explicit per
   * the kernel contract (never re-driven like refused-*, never
   * retried — repeating the identical send fails identically until
   * the deployment changes); downstream transport owns the terminal
   * surfacing (D proposes `rule_failed` naming the target,
   * `retryable: false`). Same no-call/no-record posture as the
   * refused members; the echo carries the checkpoint fenced under.
   */
  | {
      readonly status: "unavailable";
      readonly intentId: string;
      readonly claimId: string;
      readonly target: string;
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
 * from scratch); `unavailable` (D3) buckets to the terminal
 * transport member with the echoed target (never re-driven —
 * downstream transport owns the terminal surfacing).
 *
 * Ordering qualifier (R01-residual review): the KERNEL checks
 * unavailable before guard/authority evaluation — but this drive
 * awaits the snapshot pull + live authority re-read BEFORE
 * consulting the kernel, so throwing fence ports preempt an
 * unavailable verdict (pinned, not silently short-circuited).
 * True short-circuit arrives only with ACTUAL availability
 * injection (the fence input carries no availability port yet —
 * follow-up). Inherited/superseded/settled precedence stays
 * kernel-side, untouched by this mapping.
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
  if (verdict.status === "unavailable") {
    if (verdict.outboxId !== intentId) {
      throw new Error(`t32b: fence kernel unavailable verdict names another intent (producer skew?)`);
    }
    return { status: verdict.status, intentId, claimId: heldClaimId, target: verdict.target, fence: echo };
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
    // refused-revoked follows it per the committed ordering (D3:
    // unavailable precedes the guard too — the kernel never
    // evaluates guards for unavailable targets). Claimed falls
    // through to the provider below; anything else returns.
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

/* ------------------------------------------------------------------ */
/* T34-F7 fanout assembly/runtime join (ADDITIVE; every T24b/T32b path */
/* above untouched).                                                   */
/*                                                                     */
/* The L7 join over the committed F1–F5 slices:                        */
/*                                                                     */
/* - `stageFanoutTriggerJoin`: the trigger's caller-staged source      */
/*   effects (domain/history/receipt/outbox/schedules/uniques) plus    */
/*   the frozen fanout intent + checkpoint + first child chunk commit  */
/*   in ONE linkage-asserted owner batch. Trigger rejection (the       */
/*   source thunk throws), pre-admission diagnosis, or a fence         */
/*   conflict voids BOTH halves — never acknowledged unfinished.      */
/* - `claimFanoutChild` / `recordFanoutChildAttempt`: DURABLE fenced   */
/*   claim/record REPLACING F3's TEST-ONLY store. Same F1 outcomes,    */
/*   same F2 rows (built by the REAL F5 staging builders), same        */
/*   progress/turn shapes; exactly-one-winner comes from the store's   */
/*   version fence, proven on D1/DO. No `packages/work` module is      */
/*   added: conditional-update claim/record are StoragePort            */
/*   operations executable here through dynamically loaded state-dist  */
/*   producers (the T24b/T32b precedent), and a registry command       */
/*   would add run-key machinery without additional fencing.           */
/* - `runFanoutSchedulerTurn`: fair resumable scheduling — bounded    */
/*   stale-release, one bounded child page, at most maxDrives drives   */
/*   (claim -> fresh-fence invoke -> record), honest cursor/done plus  */
/*   operator progress. Sweeps chain turns; crash resumes from durable */
/*   truth (replay terminal, hold fresh claims, release stale ones).   */
/* - `fanoutFirstAttemptAnchor`: the F3/F5-owed retry-horizon anchor   */
/*   — the child row's durable `created` stamp, stable across crash.   */
/* - `requestFanoutProviderCancel`: provider cancellation ONLY per     */
/*   its accepted contract (explicit refusal without one; the          */
/*   scheduler never marks provider-accepted work unilaterally and     */
/*   never touches child rows on this path — no store parameter).      */
/*                                                                     */
/* LOADING: state producers (fanout tables/cohort/membership/outcome/  */
/* lifecycle/progress, staging, child-join port, invokeFanoutChild,    */
/* storage error classes) load dynamically from state dist through    */
/* the same P-B seam as the canonical/dispatch producers above. The   */
/* ONLY runtime mirrors are the three model literals, the F1 outcome  */
/* projection, and the staleness predicate — every staged row and     */
/* every decision builder is the REAL F5 producer; the F7 tests       */
/* cross-check the mirrors against the REAL F2/F3/F4 work sources.    */
/* Single-owner scope only: cross-store atomicity is NOT claimed.      */
/* ------------------------------------------------------------------ */

/** T34-F7: state-dist fanout module specifiers (the P-B seam). */
const STATE_FANOUT_TABLES_SPECIFIER = "@canlang/state/fanout/tables";
const STATE_FANOUT_COHORT_SPECIFIER = "@canlang/state/fanout/cohort";
const STATE_FANOUT_MEMBERSHIP_SPECIFIER = "@canlang/state/fanout/membership";
const STATE_FANOUT_OUTCOME_SPECIFIER = "@canlang/state/fanout/outcome";
const STATE_FANOUT_LIFECYCLE_SPECIFIER = "@canlang/state/fanout/lifecycle";
const STATE_FANOUT_PROGRESS_SPECIFIER = "@canlang/state/fanout/progress";
const STATE_FANOUT_STAGING_SPECIFIER = "@canlang/state/effects/staging";
/** T34-F7: storage error classes (`FenceConflictError`, `StorageConstraintError`). */
const STATE_STORAGE_PORT_SPECIFIER = "@canlang/state/storage/port";

/**
 * T34-F7 structural mirror of the F2/F5 fanout model names
 * (`work.fanout_intent`, `work.fanout_checkpoint`, `work.fanout_child`).
 * Drift is pinned by the F7 tests (these literals asserted equal to
 * the loaded state-dist constants AND the real F2 constants), not by
 * a shared import.
 */
export const T34F7_FANOUT_INTENT_MODEL = "work.fanout_intent" as ModelName;
export const T34F7_FANOUT_CHECKPOINT_MODEL = "work.fanout_checkpoint" as ModelName;
export const T34F7_FANOUT_CHILD_MODEL = "work.fanout_child" as ModelName;

/** T34-F7: structural view of F5 `FanoutIntentData`. */
export interface FanoutIntentData {
  readonly fanoutId: string;
  readonly sourceOccurrence: string;
  readonly handler: string;
  readonly cohort: FanoutCohortKind;
  readonly members: ReadonlyArray<string>;
  readonly memberCount: number;
}

/** T34-F7: structural view of F5 `FanoutCheckpointData`. */
export interface FanoutCheckpointData {
  readonly fanoutId: string;
  readonly completed: ReadonlyArray<string>;
  readonly cursor: string | null;
}

/** T34-F7: structural view of F5 `FanoutChildData`. */
export interface FanoutChildData {
  readonly fanoutId: string;
  readonly parentOccurrence: string;
  readonly handler: string;
  readonly recordId: string;
  readonly childId: string;
  readonly state: "pending" | "running" | "completed" | "skipped" | "failed";
  readonly attempts: number;
  readonly causeKind: "completed" | "skipped" | "failed" | null;
  readonly causeReason: string | null;
}

/** T34-F7: structural view of F5 `FanoutRowMeta`. */
export interface FanoutRowMeta {
  readonly nowMs: number;
  readonly actor: string;
}

/**
 * T34-F7: adopted cohort spec (structural mirror of F5
 * `FanoutCohortSpec`): whole-model enumeration of one model, or the
 * contained reverse collection of one pinned parent record.
 */
export type FanoutCohortSpec =
  | { readonly kind: "model"; readonly owner: string; readonly model: string }
  | {
      readonly kind: "anchored-collection";
      readonly owner: string;
      readonly model: string;
      readonly parent: { readonly model: string; readonly id: string };
    };

/** T34-F7: explicit source-occurrence/handler admission cutoff (F1 `FanoutCutoff`). */
export interface FanoutCutoffSpec {
  readonly sourceOccurrence: string;
  readonly handler: string;
}

/**
 * T34-F7: current lifecycle lookup for one admitted child (structural
 * mirror of F5/F4 `FanoutChildLifecycle`).
 */
export type FanoutChildLifecycle =
  | { readonly status: "present" }
  | { readonly status: "deleted" }
  | { readonly status: "moved" }
  | {
      readonly status: "unknown";
      readonly reason: "missing-record" | "inaccessible-record" | "infra-read-failure";
    };

/** T34-F7: one bounded child page (structural view of F5 `FanoutChildPage`). */
export interface FanoutChildPage {
  readonly rows: ReadonlyArray<StoredRow>;
  readonly done: boolean;
  readonly cursor: string | null;
}

/**
 * T34-F7: one executed attempt result entering record (structural
 * mirror of F3/F5 `FanoutChildAttemptResult`). `exhausted` is never
 * supplied: the horizon derives it from attempts/time.
 */
export type FanoutChildAttemptResult =
  | { readonly kind: "completed" }
  | { readonly kind: "skipped"; readonly reason: FanoutSkippedReason }
  | { readonly kind: "failed"; readonly reason: Exclude<FanoutFailedReason, "exhausted"> }
  | { readonly kind: "transient" };

/* -- T34-F7 state producers (dynamic dist loads, fail loud). -- */

/** T34-F7: structural view of the F5 fanout tables module. */
interface FanoutTablesProducer {
  readonly FANOUT_INTENT_MODEL: string;
  readonly FANOUT_CHECKPOINT_MODEL: string;
  readonly FANOUT_CHILD_MODEL: string;
  fanoutIntentRowId(sourceOccurrence: string, handler: string, cohort: FanoutCohortKind): string;
  fanoutChildRowId(parentOccurrence: string, handler: string, recordId: string): string;
  newFanoutIntentRow(
    input: {
      readonly sourceOccurrence: string;
      readonly handler: string;
      readonly cohort: FanoutCohortKind;
      readonly members: ReadonlyArray<string>;
    },
    meta: FanoutRowMeta,
  ): StoredRow;
  newFanoutCheckpointRow(
    input: {
      readonly fanoutId: string;
      readonly completed?: ReadonlyArray<string>;
      readonly cursor?: string | null;
    },
    meta: FanoutRowMeta,
  ): StoredRow;
  newFanoutChildRow(
    input: {
      readonly fanoutId: string;
      readonly parentOccurrence: string;
      readonly handler: string;
      readonly recordId: string;
    },
    meta: FanoutRowMeta,
  ): StoredRow;
  withFanoutRowData(
    row: StoredRow,
    data: Readonly<Record<string, unknown>>,
    meta: FanoutRowMeta,
  ): StoredRow;
  readFanoutIntentRow(row: StoredRow): FanoutIntentData;
  readFanoutCheckpointRow(row: StoredRow): FanoutCheckpointData;
  readFanoutChildRow(row: StoredRow): FanoutChildData;
  fanoutChildPageQuery(
    fanoutId: string,
    opts: { readonly cursor: string | null; readonly limit: number },
  ): QuerySpec;
  fanoutChildPageResult(rows: ReadonlyArray<StoredRow>, limit: number): FanoutChildPage;
}

/** T34-F7: structural view of the F5 cohort module. */
interface FanoutCohortProducer {
  checkCohortSpec(spec: FanoutCohortSpec): FanoutCohortKind;
  checkCutoffSpec(cutoff: FanoutCutoffSpec): void;
  checkFanoutChildId(child: FanoutChildId): FanoutChildId;
  diagnoseCohort(
    kind: "unsupported-cohort" | "cross-owner-cohort" | "membership-unavailable",
    message: string,
  ): FanoutCohortDiagnosis;
}

/** T34-F7: structural view of the F5 membership module. */
interface FanoutMembershipProducer {
  freezeFanoutMembership(input: {
    readonly store: StoragePort;
    readonly cutoff: FanoutCutoffSpec;
    readonly cohort: FanoutCohortSpec;
    readonly owner: string;
    readonly bounds: { readonly pageLimit: number; readonly chunkSize: number; readonly maxAttempts: number };
    readonly meta: FanoutRowMeta;
    readonly hasModel?: (model: string) => boolean;
  }): Promise<
    | {
        readonly ok: true;
        readonly frozen: {
          readonly fanoutId: string;
          readonly members: ReadonlyArray<string>;
          readonly cutoffRevision: Revision;
          readonly replayed: boolean;
        };
      }
    | { readonly ok: false; readonly diagnosis: FanoutCohortDiagnosis }
  >;
}

/** T34-F7: structural view of one staged F5 outcome write. */
export interface FanoutStagedOutcome {
  readonly write: DomainWrite & { readonly kind: "update" };
  readonly terminal: boolean;
  readonly recordId: string;
  readonly row: StoredRow;
}

/** T34-F7: structural view of the F5 outcome-staging module. */
interface FanoutOutcomeProducer {
  readonly FANOUT_T32_REFUSAL_REASON: string;
  stageFanoutChildOutcomeWrite(input: {
    readonly row: StoredRow;
    readonly result: FanoutChildAttemptResult;
    readonly nowMs: number;
    readonly firstAttemptAtMs: number;
    readonly policy: RetryPolicy;
    readonly meta: FanoutRowMeta;
  }): FanoutStagedOutcome;
  stageFanoutCheckpointAdvanceWrite(input: {
    readonly row: StoredRow;
    readonly recordId: string;
    readonly cursor?: string | null;
    readonly meta: FanoutRowMeta;
  }): DomainWrite & { readonly kind: "update" };
}

/** T34-F7: structural view of the F5 lifecycle module. */
interface FanoutLifecycleProducer {
  classifyFanoutChildLifecycle(input: {
    readonly store: StoragePort;
    readonly model: string;
    readonly recordId: string;
    readonly anchor?: { readonly model: string; readonly id: string };
  }): Promise<FanoutChildLifecycle>;
}

/** T34-F7: structural view of the F5 progress module. */
interface FanoutProgressProducer {
  readFanoutProgress(input: {
    readonly store: StoragePort;
    readonly fanoutId: string;
    readonly pageLimit: number;
  }): Promise<FanoutProgress>;
}

/** T34-F7: structural view of the L3 staging fanout entries. */
interface FanoutStagingProducer {
  stageFanoutMembership(members: ReadonlyArray<string>, what: string): string[];
}

/** T34-F7: structural view of the child-join port surface. */
interface FanoutJoinProducer {
  assertFanoutChildJoin(batch: CommitBatch): void;
}

/** Defining State admission supplies these refs anew on every execution/retry. */
interface FanoutAdmittedCall {
  readonly recordRefs: ReadonlyArray<{
    readonly param: string;
    readonly model: ModelName;
    readonly id: RecordId;
    readonly row: StoredRow;
  }>;
}

/** T34-F7: structural view of `invokeFanoutChild` (F5 admission join). */
interface FanoutInvokeProducer {
  invokeFanoutChild(input: {
    readonly registry: unknown;
    readonly store: StoragePort;
    readonly memberships: unknown;
    readonly clock: { nowMs(): number };
    readonly childOperation: string;
    readonly child: FanoutChildId;
    readonly operationId: string;
    readonly identity: ResolvedIdentity;
    readonly app: string;
    readonly source: string;
    readonly inputs: Record<string, unknown>;
    readonly execute: (call: FanoutAdmittedCall) => Promise<{
      readonly writes: ReadonlyArray<DomainWrite>;
      readonly history: ReadonlyArray<HistoryEntry>;
      readonly outbox: ReadonlyArray<OutboxIntent>;
      readonly schedules: ReadonlyArray<ScheduleOp>;
      readonly uniqueClaims: ReadonlyArray<UniqueClaim>;
      readonly uniqueReleases: ReadonlyArray<UniqueRelease>;
      readonly resolvedDefaults: Record<string, unknown>;
      readonly result: unknown;
    }>;
    readonly assertJoin: (batch: CommitBatch) => void;
  }): Promise<MutationResult>;
}

/** T34-F7: storage error classes (instanceof + name fallback). */
interface FanoutStorageErrorsProducer {
  readonly FenceConflictError: new (...args: never[]) => Error;
  readonly StorageConstraintError: new (...args: never[]) => Error;
}

/** T34-F7: loaded fanout state producers (fail loud, never partial). */
export interface FanoutStateProducers {
  readonly tables: FanoutTablesProducer;
  readonly cohort: FanoutCohortProducer;
  readonly membership: FanoutMembershipProducer;
  readonly outcome: FanoutOutcomeProducer;
  readonly lifecycle: FanoutLifecycleProducer;
  readonly progress: FanoutProgressProducer;
  readonly staging: FanoutStagingProducer;
  readonly join: FanoutJoinProducer;
  readonly invoke: FanoutInvokeProducer;
  readonly storageErrors: FanoutStorageErrorsProducer;
}

function requireProducerString(
  mod: Record<string, unknown>,
  binding: string,
  what: string,
): string {
  const value: unknown = mod[binding];
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `t34-f7: ${what} lacks non-empty string export ${JSON.stringify(binding)} (stale dist?)`,
    );
  }
  return value;
}

function requireProducerClass(
  mod: Record<string, unknown>,
  binding: string,
  what: string,
): new (...args: never[]) => Error {
  const value: unknown = mod[binding];
  if (typeof value !== "function") {
    throw new Error(
      `t34-f7: ${what} lacks class export ${JSON.stringify(binding)} (stale dist?)`,
    );
  }
  return value as new (...args: never[]) => Error;
}

/**
 * T34-F7: load the fanout state producers (tables, cohort, membership,
 * outcome, lifecycle, progress, staging, child-join assertion,
 * invokeFanoutChild, storage error classes). Dynamic dist imports
 * through the P-B seam, shape-checked fail-loud like the canonical
 * and dispatch producers. Callers pass the bundle through; public
 * entries auto-load when it is absent.
 */
export async function loadFanoutStateProducers(): Promise<FanoutStateProducers> {
  const tablesMod = await loadProducerModule(STATE_FANOUT_TABLES_SPECIFIER, "state fanout tables producer");
  const cohortMod = await loadProducerModule(STATE_FANOUT_COHORT_SPECIFIER, "state fanout cohort producer");
  const membershipMod = await loadProducerModule(
    STATE_FANOUT_MEMBERSHIP_SPECIFIER,
    "state fanout membership producer",
  );
  const outcomeMod = await loadProducerModule(STATE_FANOUT_OUTCOME_SPECIFIER, "state fanout outcome producer");
  const lifecycleMod = await loadProducerModule(
    STATE_FANOUT_LIFECYCLE_SPECIFIER,
    "state fanout lifecycle producer",
  );
  const progressMod = await loadProducerModule(
    STATE_FANOUT_PROGRESS_SPECIFIER,
    "state fanout progress producer",
  );
  const stagingMod = await loadProducerModule(STATE_FANOUT_STAGING_SPECIFIER, "state staging producer");
  const transactMod = await loadProducerModule(STATE_TRANSACT_SPECIFIER, "state transact producer");
  const invokeMod = await loadProducerModule(STATE_INVOKE_SPECIFIER, "state invoke producer");
  const portMod = await loadProducerModule(STATE_STORAGE_PORT_SPECIFIER, "state storage port producer");
  const fn = (
    mod: Record<string, unknown>,
    binding: string,
    what: string,
  ): (...args: never[]) => unknown => requireProducerFn(mod, binding, what);
  return {
    tables: {
      FANOUT_INTENT_MODEL: requireProducerString(tablesMod, "FANOUT_INTENT_MODEL", "state fanout tables producer"),
      FANOUT_CHECKPOINT_MODEL: requireProducerString(
        tablesMod,
        "FANOUT_CHECKPOINT_MODEL",
        "state fanout tables producer",
      ),
      FANOUT_CHILD_MODEL: requireProducerString(tablesMod, "FANOUT_CHILD_MODEL", "state fanout tables producer"),
      fanoutIntentRowId: fn(tablesMod, "fanoutIntentRowId", "state fanout tables producer") as unknown as FanoutTablesProducer["fanoutIntentRowId"],
      fanoutChildRowId: fn(tablesMod, "fanoutChildRowId", "state fanout tables producer") as unknown as FanoutTablesProducer["fanoutChildRowId"],
      newFanoutIntentRow: fn(tablesMod, "newFanoutIntentRow", "state fanout tables producer") as unknown as FanoutTablesProducer["newFanoutIntentRow"],
      newFanoutCheckpointRow: fn(tablesMod, "newFanoutCheckpointRow", "state fanout tables producer") as unknown as FanoutTablesProducer["newFanoutCheckpointRow"],
      newFanoutChildRow: fn(tablesMod, "newFanoutChildRow", "state fanout tables producer") as unknown as FanoutTablesProducer["newFanoutChildRow"],
      withFanoutRowData: fn(tablesMod, "withFanoutRowData", "state fanout tables producer") as unknown as FanoutTablesProducer["withFanoutRowData"],
      readFanoutIntentRow: fn(tablesMod, "readFanoutIntentRow", "state fanout tables producer") as unknown as FanoutTablesProducer["readFanoutIntentRow"],
      readFanoutCheckpointRow: fn(tablesMod, "readFanoutCheckpointRow", "state fanout tables producer") as unknown as FanoutTablesProducer["readFanoutCheckpointRow"],
      readFanoutChildRow: fn(tablesMod, "readFanoutChildRow", "state fanout tables producer") as unknown as FanoutTablesProducer["readFanoutChildRow"],
      fanoutChildPageQuery: fn(tablesMod, "fanoutChildPageQuery", "state fanout tables producer") as unknown as FanoutTablesProducer["fanoutChildPageQuery"],
      fanoutChildPageResult: fn(tablesMod, "fanoutChildPageResult", "state fanout tables producer") as unknown as FanoutTablesProducer["fanoutChildPageResult"],
    },
    cohort: {
      checkCohortSpec: fn(cohortMod, "checkCohortSpec", "state fanout cohort producer") as unknown as FanoutCohortProducer["checkCohortSpec"],
      checkCutoffSpec: fn(cohortMod, "checkCutoffSpec", "state fanout cohort producer") as unknown as FanoutCohortProducer["checkCutoffSpec"],
      checkFanoutChildId: fn(cohortMod, "checkFanoutChildId", "state fanout cohort producer") as unknown as FanoutCohortProducer["checkFanoutChildId"],
      diagnoseCohort: fn(cohortMod, "diagnoseCohort", "state fanout cohort producer") as unknown as FanoutCohortProducer["diagnoseCohort"],
    },
    membership: {
      freezeFanoutMembership: fn(membershipMod, "freezeFanoutMembership", "state fanout membership producer") as unknown as FanoutMembershipProducer["freezeFanoutMembership"],
    },
    outcome: {
      FANOUT_T32_REFUSAL_REASON: requireProducerString(
        outcomeMod,
        "FANOUT_T32_REFUSAL_REASON",
        "state fanout outcome producer",
      ),
      stageFanoutChildOutcomeWrite: fn(outcomeMod, "stageFanoutChildOutcomeWrite", "state fanout outcome producer") as unknown as FanoutOutcomeProducer["stageFanoutChildOutcomeWrite"],
      stageFanoutCheckpointAdvanceWrite: fn(outcomeMod, "stageFanoutCheckpointAdvanceWrite", "state fanout outcome producer") as unknown as FanoutOutcomeProducer["stageFanoutCheckpointAdvanceWrite"],
    },
    lifecycle: {
      classifyFanoutChildLifecycle: fn(lifecycleMod, "classifyFanoutChildLifecycle", "state fanout lifecycle producer") as unknown as FanoutLifecycleProducer["classifyFanoutChildLifecycle"],
    },
    progress: {
      readFanoutProgress: fn(progressMod, "readFanoutProgress", "state fanout progress producer") as unknown as FanoutProgressProducer["readFanoutProgress"],
    },
    staging: {
      stageFanoutMembership: fn(stagingMod, "stageFanoutMembership", "state staging producer") as unknown as FanoutStagingProducer["stageFanoutMembership"],
    },
    join: {
      assertFanoutChildJoin: fn(transactMod, "assertFanoutChildJoin", "state transact producer") as unknown as FanoutJoinProducer["assertFanoutChildJoin"],
    },
    invoke: {
      invokeFanoutChild: fn(invokeMod, "invokeFanoutChild", "state invoke producer") as unknown as FanoutInvokeProducer["invokeFanoutChild"],
    },
    storageErrors: {
      FenceConflictError: requireProducerClass(portMod, "FenceConflictError", "state storage port producer"),
      StorageConstraintError: requireProducerClass(portMod, "StorageConstraintError", "state storage port producer"),
    },
  };
}

/* -- T34-F7 mirrors (outcome projection, anchor, staleness) + error reads. -- */

/**
 * T34-F7: fence-conflict read — instanceof over the loaded class, with
 * a name fallback for rehydrated cross-boundary errors (the DO proxy
 * re-mints by name; same copy in-process). A fence conflict voids the
 * whole batch: nothing in it is durable.
 */
function isFanoutFenceConflict(error: unknown, producers: FanoutStateProducers): boolean {
  if (error instanceof producers.storageErrors.FenceConflictError) return true;
  return isUnknownRecord(error) && error["name"] === "FenceConflictError";
}

/**
 * T34-F7: storage-constraint read (PK collision / version mismatch) —
 * instanceof over the loaded class, with the same name fallback. On a
 * claim commit this is the exactly-one-winner signal: a rival won.
 */
function isFanoutStorageConstraint(error: unknown, producers: FanoutStateProducers): boolean {
  if (error instanceof producers.storageErrors.StorageConstraintError) return true;
  return isUnknownRecord(error) && error["name"] === "StorageConstraintError";
}

/** T34-F7: structural `StateError` code read (invoke/body failures). */
function fanoutStateErrorCode(error: unknown): string | null {
  if (!isUnknownRecord(error)) return null;
  if (error["name"] !== "StateError") return null;
  const code: unknown = error["code"];
  return typeof code === "string" ? code : null;
}

/**
 * T34-F7: project the recorded terminal outcome from child data, or
 * null when the child is still live. Structural mirror of F3's
 * `fanoutChildOutcomeFromRow` (cross-checked in the F7 tests against
 * the REAL F3 projection over identical rows).
 */
export function fanoutChildOutcomeFromData(data: FanoutChildData): FanoutChildOutcome | null {
  if (data.state === "pending" || data.state === "running") return null;
  const child: FanoutChildId = {
    parentOccurrence: data.parentOccurrence,
    handler: data.handler,
    recordId: data.recordId,
  };
  if (data.state === "completed") {
    return { child, state: "completed", attempts: data.attempts, cause: { kind: "completed" } };
  }
  if (data.state === "skipped") {
    return {
      child,
      state: "skipped",
      attempts: data.attempts,
      cause: { kind: "skipped", reason: data.causeReason as FanoutSkippedReason },
    };
  }
  return {
    child,
    state: "failed",
    attempts: data.attempts,
    cause: { kind: "failed", reason: data.causeReason as FanoutFailedReason },
  };
}

/**
 * T34-F7: the F3/F5-owed first-attempt anchor — the child row's durable
 * `created` stamp. Admission anchors the retry horizon: `created` is
 * written once at admission, never moves under claim/record
 * transitions, and survives crash, so the horizon enforces from
 * durable truth on every restart. Conservative by construction (the
 * horizon runs from admission, not from the first execution).
 */
export function fanoutFirstAttemptAnchor(row: StoredRow): number {
  if (!Number.isFinite(row.created) || row.created < 0) {
    throw new Error("t34-f7: fanout child row created is not a valid first-attempt anchor.");
  }
  return row.created;
}

/**
 * T34-F7: a fanout claim is stale once its age reaches the max age
 * (boundary inclusive). Structural mirror of F4's
 * `isFanoutClaimStale` (cross-checked in the F7 tests against the
 * REAL F4 predicate). Callers pass the running row's `updated` stamp
 * as the claim instant (F4-exact: the claim IS the pending -> running
 * row transition).
 */
export function isFanoutRowClaimStale(
  claimedAtMs: number,
  nowMs: number,
  maxClaimAgeMs: number,
): boolean {
  if (!Number.isFinite(claimedAtMs) || claimedAtMs < 0) {
    throw new RangeError("t34-f7: claimedAtMs must be finite and >= 0");
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError("t34-f7: nowMs must be finite and >= 0");
  }
  if (!Number.isFinite(maxClaimAgeMs) || maxClaimAgeMs < 0) {
    throw new RangeError("t34-f7: maxClaimAgeMs must be finite and >= 0");
  }
  return claimedAtMs + maxClaimAgeMs <= nowMs;
}

function checkFanoutRowMeta(meta: FanoutRowMeta, what: string): void {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new Error(`t34-f7: ${what} needs meta.nowMs as finite epoch ms >= 0.`);
  }
  checkClosedText(meta.actor, `${what} meta actor`);
}

function checkFanoutPolicy(policy: RetryPolicy, what: string): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(`t34-f7: ${what} needs policy.maxAttempts as an integer >= 1.`);
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new Error(`t34-f7: ${what} needs policy.horizonMs finite and > 0.`);
  }
}

function checkFanoutAttemptResult(result: FanoutChildAttemptResult): void {
  if (result.kind === "failed" && (result.reason as string) === "exhausted") {
    throw new Error("t34-f7: exhausted is derived by the horizon, never supplied (F3-exact).");
  }
}

function fanoutTerminalOrThrow(row: StoredRow, data: FanoutChildData, what: string): FanoutChildOutcome {
  void row;
  const outcome = fanoutChildOutcomeFromData(data);
  if (outcome === null) {
    throw new Error(`t34-f7: unreachable: ${what} produced a live row.`);
  }
  return outcome;
}

/* -- T34-F7 atomic trigger/intent staging. -- */

/** T34-F7: the trigger's caller-staged source effects (uncommitted). */
export interface FanoutTriggerSourceEffects {
  readonly writes: ReadonlyArray<DomainWrite>;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly receipt: Receipt | null;
  readonly outbox: ReadonlyArray<OutboxIntent>;
  readonly schedules: ReadonlyArray<ScheduleOp>;
  readonly uniqueClaims: ReadonlyArray<UniqueClaim>;
  readonly uniqueReleases: ReadonlyArray<UniqueRelease>;
}

/** T34-F7: explicit trigger-join bounds (no defaults, no quota field). */
export interface FanoutTriggerJoinBounds {
  /** Enumeration page transport bound (chunk size, never cohort size). */
  readonly pageLimit: number;
  /** First-chunk child admission bound (remaining chunks via freeze replay). */
  readonly chunkSize: number;
}

/** T34-F7: one atomic trigger/intent staging request. */
export interface StageFanoutTriggerJoinOpts {
  readonly store: StoragePort;
  readonly cutoff: FanoutCutoffSpec;
  readonly cohort: FanoutCohortSpec;
  /** Operating owner (the checkpoint owner); specs naming another owner diagnose. */
  readonly owner: string;
  readonly bounds: FanoutTriggerJoinBounds;
  readonly meta: FanoutRowMeta;
  /**
   * Caller-staged source truth, run INSIDE the seam before any store
   * read. Receives the deterministic fanout id. A throw IS the
   * trigger rejection: it voids the intent too (nothing staged,
   * nothing committed).
   */
  readonly stageSource: (fanout: { readonly fanoutId: string }) => FanoutTriggerSourceEffects | Promise<FanoutTriggerSourceEffects>;
  /**
   * Known-model guard (see F5 `FreezeMembershipInput.hasModel`): when
   * present and the cohort model is unknown, the join diagnoses
   * `unsupported-cohort` instead of freezing an empty set.
   */
  readonly hasModel?: (model: string) => boolean;
  readonly producers?: FanoutStateProducers;
}

/** T34-F7: atomic trigger/intent staging outcome. */
export type StageFanoutTriggerJoinOutcome =
  | {
      readonly ok: true;
      readonly fanoutId: string;
      readonly members: ReadonlyArray<string>;
      /** Fence revision the enumeration + commit held. */
      readonly cutoffRevision: Revision;
      /** Revision the joint commit produced. */
      readonly commitRevision: Revision;
      /** Total admission chunks; the trigger commit staged the first. */
      readonly chunksTotal: number;
      /** Non-null while admission chunks remain (resume, never complete). */
      readonly cursor: string | null;
    }
  | { readonly ok: false; readonly diagnosis: FanoutCohortDiagnosis };

/** T34-F7: opaque admission cursor while chunks remain (F5-exact shape). */
function fanoutAdmitCursor(nextChunkIndex: number): string {
  return `admit/${nextChunkIndex}`;
}

/**
 * T34-F7: drain one cohort's member identities in bounded id-sorted
 * pages (F5 `drainCohortIdentities`-exact queries: archived rows
 * INCLUDE — they freeze as members and record skipped/deleted when
 * their child executes, so every stored identity gets one accounted
 * outcome). Over-return is a store contract violation (loud throw);
 * anything else the store throws is the caller's to diagnose.
 */
async function drainFanoutCohortIdentities(
  store: StoragePort,
  cohort: FanoutCohortSpec,
  pageLimit: number,
): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = await store.query({
      model: cohort.model as ModelName,
      ...(cohort.kind === "anchored-collection"
        ? {
            parent: {
              model: cohort.parent.model as ModelName,
              id: cohort.parent.id as RecordId,
            },
          }
        : {}),
      ...(cursor === null
        ? {}
        : { where: { op: "gt", field: "id", value: cursor } as const }),
      order: [{ field: "id", direction: "asc" }],
      limit: pageLimit,
      archived: "include",
      authority: "owner",
    });
    if (rows.length > pageLimit) {
      throw new Error(`t34-f7: fanout enumeration returned ${rows.length} rows past limit ${pageLimit}.`);
    }
    for (const row of rows) {
      members.push(row.id as string);
    }
    if (rows.length < pageLimit) return members;
    const last = rows[rows.length - 1];
    if (last === undefined) {
      throw new Error("t34-f7: fanout enumeration hit an unreachable empty full page.");
    }
    cursor = last.id as string;
  }
}

/**
 * T34-F7: classify the anchored-collection anchor (F5
 * `classifyAnchor`-exact): present (even archived) or tombstoned
 * anchors are KNOWN; a missing anchor with no disposal history is
 * UNKNOWN (freezing empty would bless a mis-specified cohort).
 */
async function classifyFanoutAnchor(
  store: StoragePort,
  parent: { readonly model: string; readonly id: string },
): Promise<{ readonly known: boolean }> {
  const row = await store.load(parent.model as ModelName, parent.id as RecordId);
  if (row !== null) return { known: true };
  const history = await store.historyFor(parent.model as ModelName, parent.id as RecordId);
  for (const entry of history) {
    if (entry.change === "remove" || entry.change === "archive") return { known: true };
  }
  return { known: false };
}

/**
 * T34-F7: stage the trigger's source truth plus the frozen fanout
 * intent + checkpoint + first child chunk and commit them in ONE
 * linkage-asserted owner batch (§C2: parent/source success means its
 * own domain truth and durable fanout intent committed atomically).
 *
 * Order: pre-admission validation (spec/cutoff/owner/model/bounds —
 * diagnoses before ANY store write) -> source staging (a throw IS
 * the trigger rejection: both halves void) -> fence-revision
 * enumeration + anchor classification -> member-set validation ->
 * ONE joint commit (source writes first, then intent + checkpoint +
 * first chunk). A fence conflict voids the whole batch (both halves
 * — retryable diagnosis); an intent PK collision means a rival
 * freeze won (duplicate trigger: nothing committed — the caller
 * replays its trigger receipt, never redefines the frozen set).
 * Remaining admission chunks complete through the scheduler's
 * freeze-replay (F5 `freezeFanoutMembership`, idempotent).
 *
 * Single-shot throughout (T24b precedent): fence conflicts diagnose
 * (NO retry — callers decide); malformed caller input throws.
 */
export async function stageFanoutTriggerJoin(
  opts: StageFanoutTriggerJoinOpts,
): Promise<StageFanoutTriggerJoinOutcome> {
  const producers = opts.producers ?? (await loadFanoutStateProducers());
  producers.cohort.checkCutoffSpec(opts.cutoff);
  const cohortKind = producers.cohort.checkCohortSpec(opts.cohort);
  checkFanoutRowMeta(opts.meta, "trigger join");
  if (!Number.isInteger(opts.bounds.pageLimit) || opts.bounds.pageLimit < 1) {
    throw new Error("t34-f7: trigger join needs bounds.pageLimit as an integer >= 1.");
  }
  if (!Number.isInteger(opts.bounds.chunkSize) || opts.bounds.chunkSize < 1) {
    throw new Error("t34-f7: trigger join needs bounds.chunkSize as an integer >= 1.");
  }
  if (typeof opts.owner !== "string" || opts.owner === "") {
    throw new Error("t34-f7: trigger join needs a non-empty operating owner.");
  }
  if (opts.cohort.owner !== opts.owner) {
    return {
      ok: false,
      diagnosis: producers.cohort.diagnoseCohort(
        "cross-owner-cohort",
        `Fanout cohort owner ${JSON.stringify(opts.cohort.owner)} is outside operating owner ` +
          `${JSON.stringify(opts.owner)}; the child transaction cannot cross owners.`,
      ),
    };
  }
  if (opts.hasModel !== undefined && !opts.hasModel(opts.cohort.model)) {
    return {
      ok: false,
      diagnosis: producers.cohort.diagnoseCohort(
        "unsupported-cohort",
        `Fanout cohort model ${JSON.stringify(opts.cohort.model)} is not a servable model.`,
      ),
    };
  }
  const fanoutId = producers.tables.fanoutIntentRowId(
    opts.cutoff.sourceOccurrence,
    opts.cutoff.handler,
    cohortKind,
  );
  // The trigger rejection point: a throw here stages nothing and
  // commits nothing — source truth and fanout intent void together.
  const source = await opts.stageSource({ fanoutId });
  let revision: Revision;
  let enumerated: string[];
  try {
    revision = await opts.store.readRevision();
    enumerated = await drainFanoutCohortIdentities(opts.store, opts.cohort, opts.bounds.pageLimit);
    if (opts.cohort.kind === "anchored-collection") {
      const anchor = await classifyFanoutAnchor(opts.store, opts.cohort.parent);
      if (!anchor.known) {
        return {
          ok: false,
          diagnosis: producers.cohort.diagnoseCohort(
            "membership-unavailable",
            `Fanout anchor ${JSON.stringify(opts.cohort.parent.model)}/` +
              `${JSON.stringify(opts.cohort.parent.id)} is unknown; refusing to freeze ` +
              "an empty sweep over an unknowable collection.",
          ),
        };
      }
    }
  } catch (error) {
    if (fanoutStateErrorCode(error) !== null) throw error;
    if (error instanceof Error && error.message.startsWith("t34-f7: fanout enumeration")) throw error;
    return {
      ok: false,
      diagnosis: producers.cohort.diagnoseCohort(
        "membership-unavailable",
        `Fanout enumeration failed: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
  let members: ReadonlyArray<string>;
  try {
    members = producers.staging.stageFanoutMembership(enumerated, "work.fanout_intent.members");
  } catch (error) {
    return {
      ok: false,
      diagnosis: producers.cohort.diagnoseCohort(
        "membership-unavailable",
        `Fanout enumeration disagrees with the store: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
  const chunksTotal = Math.max(1, Math.ceil(members.length / opts.bounds.chunkSize));
  const firstChunk = members.slice(0, opts.bounds.chunkSize);
  const singleCommit = chunksTotal <= 1;
  const intentRow = producers.tables.newFanoutIntentRow(
    {
      sourceOccurrence: opts.cutoff.sourceOccurrence,
      handler: opts.cutoff.handler,
      cohort: cohortKind,
      members,
    },
    opts.meta,
  );
  const checkpointRow = producers.tables.newFanoutCheckpointRow(
    { fanoutId, completed: [], cursor: singleCommit ? null : fanoutAdmitCursor(1) },
    opts.meta,
  );
  const batch: CommitBatch = {
    expectedRevision: revision,
    writes: [
      ...source.writes,
      { kind: "insert", model: T34F7_FANOUT_INTENT_MODEL, row: intentRow },
      { kind: "insert", model: T34F7_FANOUT_CHECKPOINT_MODEL, row: checkpointRow },
      ...firstChunk.map((recordId) => ({
        kind: "insert" as const,
        model: T34F7_FANOUT_CHILD_MODEL,
        row: producers.tables.newFanoutChildRow(
          {
            fanoutId,
            parentOccurrence: opts.cutoff.sourceOccurrence,
            handler: opts.cutoff.handler,
            recordId,
          },
          opts.meta,
        ),
      })),
    ],
    history: [...source.history],
    receipt: source.receipt,
    outbox: [...source.outbox],
    schedules: [...source.schedules],
    uniqueClaims: [...source.uniqueClaims],
    uniqueReleases: [...source.uniqueReleases],
  };
  // Linkage-asserted, then ONE commit (the `invokeFanoutChild`
  // wrapped-store shape): source truth and fanout intent land
  // together or not at all.
  producers.join.assertFanoutChildJoin(batch);
  try {
    const committed = await opts.store.commit(batch);
    return {
      ok: true,
      fanoutId,
      members,
      cutoffRevision: revision,
      commitRevision: committed.revision,
      chunksTotal,
      cursor: singleCommit ? null : fanoutAdmitCursor(1),
    };
  } catch (error) {
    if (fanoutStateErrorCode(error) !== null) throw error;
    if (isFanoutFenceConflict(error, producers)) {
      return {
        ok: false,
        diagnosis: producers.cohort.diagnoseCohort(
          "membership-unavailable",
          "Fanout trigger join lost the fence; concurrent writes never freeze a partial set " +
            "(nothing committed — retry).",
        ),
      };
    }
    if (isFanoutStorageConstraint(error, producers)) {
      return {
        ok: false,
        diagnosis: producers.cohort.diagnoseCohort(
          "membership-unavailable",
          "Fanout intent is already frozen for this cutoff; the trigger half was NOT committed " +
            "(replay the trigger receipt — the frozen set is never redefined).",
        ),
      };
    }
    return {
      ok: false,
      diagnosis: producers.cohort.diagnoseCohort(
        "membership-unavailable",
        `Fanout trigger commit failed: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
}

/* -- T34-F7/C1 emitted-cohort consumer (generated-serving join). -- */

/**
 * T34-F7/C1: emitted `appDefinition.cohorts` member shape (F6
 * `ArtifactCohortDescriptor`, keyed by canonical handler identity).
 * Test fixtures annotate with this so the honest emission shape is
 * a compile-time constraint, not a comment.
 */
export type EmittedAppDefinitionCohorts = Readonly<Record<string, ArtifactCohortDescriptor>>;

/**
 * T34-F7/C1: emitted `appDefinition.models` containment view. Only
 * `parent` is read (the `ChildOf` edge renders `parent:` — the
 * compiler, not this join, owns that edge); richer members pass
 * through untouched.
 */
export type EmittedAppDefinitionModels = Readonly<
  Record<string, { readonly parent?: string } | undefined>
>;

/**
 * T34-F7/C1: resolve one emitted `appDefinition.cohorts[handler]`
 * descriptor plus its trigger context into the runtime
 * `FanoutCohortSpec` the trigger join stages. This is the actual
 * Cloudflare consumer of the F6 emission: the compiler descriptor
 * never carries owner, identity sets, quotas, or cursors (all
 * runtime-owned), so the operating owner arrives from the trigger
 * context, and anchored cohorts resolve their parent id from the
 * trigger event plus their parent model from the emitted
 * containment edge.
 *
 * Fail-loud throughout (an honest compiler emits checked cohorts
 * only — E4055 stays fail-closed with no descriptor): a trigger
 * for a handler with no descriptor, a malformed descriptor, a
 * non-event-rooted parent path, an unresolvable parent id, or a
 * child with no contained parent all throw naming the handler.
 * Well-formed specs still flow through the trigger join's own
 * admission diagnoses (unsupported model, unknown anchor).
 *
 * The header `as` binding (`bind`) is shape-checked and otherwise
 * ignored here: child-variable binding rides the scheduler body
 * port when the compiled handler body runs, not the cohort spec.
 */
export interface ResolveEmittedFanoutCohortInput {
  /** Entry module's emitted `appDefinition.cohorts` member (untrusted: validated). */
  readonly cohorts: unknown;
  /** Canonical handler identity admitting this cohort (=== cutoff.handler at the join). */
  readonly handler: string;
  /** Operating owner attested for the resolved spec. */
  readonly owner: string;
  /** Trigger event record the anchored parent path resolves against (`event` root). */
  readonly event: unknown;
  /** Entry module's emitted `appDefinition.models` member (anchored parent-model only). */
  readonly models: unknown;
}

function readEmittedCohortRecord(value: unknown, what: string, handler: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`t34-f7: emitted fanout ${what} for handler ${JSON.stringify(handler)} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readEmittedCohortString(value: unknown, what: string, handler: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `t34-f7: emitted fanout ${what} for handler ${JSON.stringify(handler)} must be a non-empty string.`,
    );
  }
  return value;
}

export function resolveEmittedFanoutCohort(input: ResolveEmittedFanoutCohortInput): FanoutCohortSpec {
  if (typeof input.handler !== "string" || input.handler === "") {
    throw new Error("t34-f7: emitted fanout cohort resolution needs a non-empty handler identity.");
  }
  if (typeof input.owner !== "string" || input.owner === "") {
    throw new Error("t34-f7: emitted fanout cohort resolution needs a non-empty operating owner.");
  }
  const cohorts = readEmittedCohortRecord(input.cohorts, "appDefinition.cohorts", input.handler);
  const raw = cohorts[input.handler];
  if (raw === undefined) {
    throw new Error(
      `t34-f7: handler ${JSON.stringify(input.handler)} names no emitted fanout cohort ` +
        `(${Object.keys(cohorts).length} emitted cohorts; triggers fire for fanout handlers only).`,
    );
  }
  const descriptor = readEmittedCohortRecord(raw, "cohort descriptor", input.handler);
  const kind: unknown = descriptor["kind"];
  if (kind !== "model" && kind !== "anchored-collection") {
    throw new Error(
      `t34-f7: emitted fanout cohort for handler ${JSON.stringify(input.handler)} has kind ` +
        `${JSON.stringify(kind)} (want "model" or "anchored-collection").`,
    );
  }
  const model = readEmittedCohortString(descriptor["model"], "cohort model", input.handler);
  const bind: unknown = descriptor["bind"];
  if (typeof bind !== "string" && bind !== null) {
    throw new Error(
      `t34-f7: emitted fanout cohort for handler ${JSON.stringify(input.handler)} has a non-string ` +
        `non-null "as" binding.`,
    );
  }
  if (kind === "model") {
    return { kind: "model", owner: input.owner, model };
  }
  // Anchored: parent id from the trigger event, parent model from
  // the emitted containment edge. Both are required: freezing over
  // a mis-specified collection would bless the wrong sweep.
  const parentPath = readEmittedCohortString(descriptor["parent"], "cohort parent path", input.handler);
  const segments = parentPath.split(".");
  if (segments[0] !== "event" || segments.length < 2 || segments.some((segment) => segment === "")) {
    throw new Error(
      `t34-f7: emitted fanout cohort for handler ${JSON.stringify(input.handler)} has a non-event-rooted ` +
        `parent path ${JSON.stringify(parentPath)} (want "event.<field>[.<field>]").`,
    );
  }
  const models = readEmittedCohortRecord(input.models, "appDefinition.models", input.handler);
  const child = readEmittedCohortRecord(models[model], `model ${JSON.stringify(model)}`, input.handler);
  const parentModel = readEmittedCohortString(
    child["parent"],
    `contained parent of model ${JSON.stringify(model)}`,
    input.handler,
  );
  let current: unknown = input.event;
  for (const segment of segments.slice(1)) {
    current = readEmittedCohortRecord(current, `event segment ${JSON.stringify(segment)}`, input.handler)[segment];
  }
  if (typeof current !== "string" || current === "") {
    throw new Error(
      `t34-f7: emitted fanout cohort for handler ${JSON.stringify(input.handler)} resolves parent path ` +
        `${JSON.stringify(parentPath)} to a non-string id.`,
    );
  }
  return { kind: "anchored-collection", owner: input.owner, model, parent: { model: parentModel, id: current } };
}

/**
 * T34-F7/C1: stage one emitted cohort's trigger join: look the
 * `cutoff.handler` descriptor up in the entry module's emitted
 * `appDefinition.cohorts`, resolve it against the trigger context,
 * and stage through the real `stageFanoutTriggerJoin`. The cutoff
 * handler is the single lookup key (no second handler field, no
 * skew); resolution throws fail-loud before ANY store write, and
 * admission diagnoses flow through unchanged.
 *
 * This entry is the serving join the worker's fanout driver calls;
 * it is intentionally NOT a seventh assembly segment (the six
 * segments are the composed mechanism entries; the driver supplies
 * the entry module + trigger event per fire).
 */
export interface StageEmittedFanoutTriggerJoinOpts extends Omit<StageFanoutTriggerJoinOpts, "cohort"> {
  /** Entry module's emitted `appDefinition.cohorts` member (untrusted: validated). */
  readonly cohorts: unknown;
  /** Entry module's emitted `appDefinition.models` member (anchored parent-model only). */
  readonly models: unknown;
  /** Trigger event record the anchored parent path resolves against. */
  readonly event: unknown;
}

export async function stageEmittedFanoutTriggerJoin(
  opts: StageEmittedFanoutTriggerJoinOpts,
): Promise<StageFanoutTriggerJoinOutcome> {
  const cohort = resolveEmittedFanoutCohort({
    cohorts: opts.cohorts,
    handler: opts.cutoff.handler,
    owner: opts.owner,
    event: opts.event,
    models: opts.models,
  });
  // The emission keys (cohorts/models/event) ride the spread and are
  // ignored downstream; every staged field arrives explicitly.
  return stageFanoutTriggerJoin({ ...opts, cohort });
}

/* -- T34-F7 durable fenced claim/record (F3 TEST-ONLY replacement). -- */

/**
 * T34-F7: the claim-time fence gate for one fanout child claim. Absent
 * (the default) keeps the exact F3 unfenced behavior — no scope, no
 * authority re-read. Present, the claim opens its OWN fresh checkpoint
 * via `openTransitiveScope` (T32b precedent — never a carried
 * snapshot) and applies the committed F3/T32b ordering:
 * inherited-scope (before the guard) -> guard on CURRENT -> revoked
 * (after the guard). Both refusals pin terminal `failed` with the
 * REAL F5 `FANOUT_T32_REFUSAL_REASON` (`inaccessible-record`: an
 * authority failure, never deletion, never retried).
 */
export interface FanoutClaimFenceInput {
  readonly owner: string;
  readonly triggerRevision?: { readonly revision: number };
  readonly revalidateAuthority: () => boolean | Promise<boolean>;
}

/** T34-F7: one durable claim attempt against a single admitted child. */
export interface ClaimFanoutChildOpts {
  readonly store: StoragePort;
  /** Parent+handler+record identity to claim (handler prevents collisions). */
  readonly child: FanoutChildId;
  /**
   * Caller's observed `StoredRow.version`, or null for an
   * unconditional attempt (no staleness check). A mismatch refuses
   * as stale without admitting: stale reads never win.
   */
  readonly snapshotVersion: number | null;
  /** Body/filter guard; null predicate means unconditional. */
  readonly guard: { readonly predicate: string | null };
  /** Retained frozen lexical inputs for the guard. */
  readonly frozenInputs: unknown;
  /**
   * CURRENT owner-state snapshot thunk, invoked at claim time
   * (after the inherited-scope check, before guard evaluation).
   * The guard always sees this fresh value, never a carried one.
   */
  readonly readCurrentSnapshot: () => unknown | Promise<unknown>;
  /** Injected pure guard evaluator (F3 `GuardEvaluator` shape). */
  readonly evaluateGuard: (
    predicate: string,
    frozenInputs: unknown,
    stateSnapshot: unknown,
  ) => boolean;
  readonly fence?: FanoutClaimFenceInput;
  /** Explicit per-call bounds (pins carry them; no default, no quota field). */
  readonly policy: RetryPolicy;
  readonly meta: FanoutRowMeta;
  readonly producers?: FanoutStateProducers;
}

/** T34-F7: durable claim outcome (F3-identical statuses and shapes). */
export type FanoutChildClaimOutcome =
  /** Winner: pending -> running, version bumped, attempts unchanged. */
  | { readonly status: "claimed"; readonly row: StoredRow; readonly child: FanoutChildId }
  /** Already running: existing claim returned, no mutation, no duplicate. */
  | { readonly status: "held"; readonly row: StoredRow; readonly child: FanoutChildId }
  /** Already terminal: recorded outcome replayed, minting nothing. */
  | { readonly status: "replayed"; readonly outcome: FanoutChildOutcome; readonly row: StoredRow }
  /** Stale snapshot: current row returned, nothing admitted, guard not run. */
  | { readonly status: "refused-stale"; readonly row: StoredRow; readonly child: FanoutChildId }
  /** T32 inherited scope: pinned failed, guard never ran. */
  | { readonly status: "refused-inherited-scope"; readonly outcome: FanoutChildOutcome; readonly row: StoredRow }
  /** T32 revoked authority: pinned failed, guard already ran. */
  | { readonly status: "refused-revoked"; readonly outcome: FanoutChildOutcome; readonly row: StoredRow }
  /** Guard-false on the current snapshot: pinned skipped/non-applicable. */
  | { readonly status: "skipped"; readonly outcome: FanoutChildOutcome; readonly row: StoredRow };

/** T34-F7: pin result (pending-row claim-time pin, attempts unchanged). */
interface FanoutPinResult {
  readonly row: StoredRow;
  readonly outcome: FanoutChildOutcome;
}

/**
 * T34-F7: pin one live child terminal (pending-row pins keep
 * attempts UNCHANGED — nothing executed; running-row failed pins
 * count the rejected attempt — F5-exact) with its checkpoint
 * advance in ONE linkage-asserted batch. A lost pin race observes
 * the winner (terminal replay); an unlosable conflict rethrows for
 * the caller.
 */
async function pinFanoutChildTerminal(input: {
  readonly store: StoragePort;
  readonly childRow: StoredRow;
  readonly result:
    | { readonly kind: "skipped"; readonly reason: FanoutSkippedReason }
    | { readonly kind: "failed"; readonly reason: Exclude<FanoutFailedReason, "exhausted"> };
  readonly nowMs: number;
  readonly policy: RetryPolicy;
  readonly meta: FanoutRowMeta;
  readonly producers: FanoutStateProducers;
  readonly what: string;
}): Promise<FanoutPinResult> {
  const { store, childRow, result, nowMs, policy, meta, producers, what } = input;
  const data = producers.tables.readFanoutChildRow(childRow);
  const checkpointRow = await store.load(T34F7_FANOUT_CHECKPOINT_MODEL, data.fanoutId as RecordId);
  if (checkpointRow === null) {
    throw new Error(`t34-f7: ${what}: checkpoint row missing for a terminal pin.`);
  }
  const checkpoint = producers.tables.readFanoutCheckpointRow(checkpointRow);
  const staged = producers.outcome.stageFanoutChildOutcomeWrite({
    row: childRow,
    result,
    nowMs,
    firstAttemptAtMs: fanoutFirstAttemptAnchor(childRow),
    policy,
    meta,
  });
  const advance = producers.outcome.stageFanoutCheckpointAdvanceWrite({
    row: checkpointRow,
    recordId: staged.recordId,
    cursor: checkpoint.cursor,
    meta,
  });
  const batch: CommitBatch = {
    expectedRevision: await store.readRevision(),
    writes: [staged.write, advance],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
  producers.join.assertFanoutChildJoin(batch);
  try {
    await store.commit(batch);
  } catch (error) {
    if (fanoutStateErrorCode(error) !== null) throw error;
    if (!isFanoutFenceConflict(error, producers) && !isFanoutStorageConstraint(error, producers)) {
      throw error;
    }
    const reloaded = await store.load(T34F7_FANOUT_CHILD_MODEL, childRow.id);
    if (reloaded === null) {
      throw new Error(`t34-f7: ${what}: child row vanished under a pin race.`);
    }
    const reloadedData = producers.tables.readFanoutChildRow(reloaded);
    const replayed = fanoutChildOutcomeFromData(reloadedData);
    if (replayed === null) throw error;
    return { row: reloaded, outcome: replayed };
  }
  const stagedData = producers.tables.readFanoutChildRow(staged.row);
  return { row: staged.row, outcome: fanoutTerminalOrThrow(staged.row, stagedData, what) };
}

/**
 * T34-F7: claim one child durably — terminal replays, running holds,
 * stale refuses, then inherited-scope -> guard-on-current ->
 * revoked -> claim (F3-exact order; later checks never run once an
 * earlier one decides). Refusals and guard-false pin terminally with
 * the checkpoint advance in ONE linkage-asserted batch; the claim is
 * a fenced pending -> running conditional update (attempts
 * unchanged). Exactly-one-winner: concurrent claimants serialize on
 * the store version fence and losers observe the winner (held /
 * replayed / refused-stale — never a double claim, never a throw).
 * Single-shot (T24b precedent): a fence conflict with the row still
 * pending reads as refused-stale (the world moved; re-drive).
 */
export async function claimFanoutChild(
  opts: ClaimFanoutChildOpts,
): Promise<FanoutChildClaimOutcome> {
  const producers = opts.producers ?? (await loadFanoutStateProducers());
  checkFanoutRowMeta(opts.meta, "claim");
  checkFanoutPolicy(opts.policy, "claim");
  producers.cohort.checkFanoutChildId(opts.child);
  if (opts.fence !== undefined) {
    checkClosedText(opts.fence.owner, "claim fence owner");
    if (typeof opts.fence.revalidateAuthority !== "function") {
      throw new Error("t34-f7: claim fence needs a revalidateAuthority function.");
    }
    const triggerRevision = opts.fence.triggerRevision;
    if (triggerRevision !== undefined) {
      const rev: unknown = triggerRevision.revision;
      if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) {
        throw new Error("t34-f7: claim fence triggerRevision must be an integer revision >= 0.");
      }
    }
  }
  const key = producers.tables.fanoutChildRowId(
    opts.child.parentOccurrence,
    opts.child.handler,
    opts.child.recordId,
  );
  const current = await opts.store.load(T34F7_FANOUT_CHILD_MODEL, key as RecordId);
  if (current === null) {
    throw new Error(`t34-f7: no fanout child row for ${JSON.stringify(key)} (producer write missing).`);
  }
  const data = producers.tables.readFanoutChildRow(current);
  const terminal = fanoutChildOutcomeFromData(data);
  if (terminal !== null) {
    return { status: "replayed", outcome: terminal, row: current };
  }
  if (data.state === "running") {
    return { status: "held", row: current, child: opts.child };
  }
  if (opts.snapshotVersion !== null && opts.snapshotVersion !== current.version) {
    return { status: "refused-stale", row: current, child: opts.child };
  }
  const fence = opts.fence;
  if (fence !== undefined) {
    // The dispatch's OWN fresh checkpoint (T32b precedent: never a
    // carried snapshot); presenting the trigger's revision back is
    // inheriting and refuses before the guard runs.
    const admission = await loadFenceAdmissionProducer();
    const checkpoint = (await admission.openTransitiveScope(opts.store, fence.owner)).snapshot();
    if (
      fence.triggerRevision !== undefined &&
      fence.triggerRevision.revision === (checkpoint.revision as number)
    ) {
      const pinned = await pinFanoutChildTerminal({
        store: opts.store,
        childRow: current,
        result: {
          kind: "failed",
          reason: producers.outcome.FANOUT_T32_REFUSAL_REASON as Exclude<FanoutFailedReason, "exhausted">,
        },
        nowMs: opts.meta.nowMs,
        policy: opts.policy,
        meta: opts.meta,
        producers,
        what: "refused-inherited-scope",
      });
      return { status: "refused-inherited-scope", outcome: pinned.outcome, row: pinned.row };
    }
  }
  const predicate = opts.guard.predicate;
  if (predicate !== null) {
    // Claim-time guard re-evaluation on a CURRENT snapshot (pulled
    // after the row load, before the claim): only an explicit `true`
    // proceeds. Evaluator throws propagate with nothing committed —
    // a throwing evaluator must never terminally skip.
    const snapshot = await opts.readCurrentSnapshot();
    const verdict = opts.evaluateGuard(predicate, opts.frozenInputs, snapshot);
    if (verdict !== true) {
      const pinned = await pinFanoutChildTerminal({
        store: opts.store,
        childRow: current,
        result: { kind: "skipped", reason: "non-applicable" },
        nowMs: opts.meta.nowMs,
        policy: opts.policy,
        meta: opts.meta,
        producers,
        what: "guard-false skip",
      });
      return { status: "skipped", outcome: pinned.outcome, row: pinned.row };
    }
  }
  if (fence !== undefined && (await fence.revalidateAuthority()) !== true) {
    const pinned = await pinFanoutChildTerminal({
      store: opts.store,
      childRow: current,
      result: {
        kind: "failed",
        reason: producers.outcome.FANOUT_T32_REFUSAL_REASON as Exclude<FanoutFailedReason, "exhausted">,
      },
      nowMs: opts.meta.nowMs,
      policy: opts.policy,
      meta: opts.meta,
      producers,
      what: "refused-revoked",
    });
    return { status: "refused-revoked", outcome: pinned.outcome, row: pinned.row };
  }
  const running = producers.tables.withFanoutRowData(
    current,
    { ...data, state: "running" },
    opts.meta,
  );
  try {
    await opts.store.commit({
      expectedRevision: await opts.store.readRevision(),
      writes: [
        {
          kind: "update",
          model: T34F7_FANOUT_CHILD_MODEL,
          id: current.id,
          expectedVersion: current.version,
          row: running,
        },
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
  } catch (error) {
    if (fanoutStateErrorCode(error) !== null) throw error;
    if (!isFanoutFenceConflict(error, producers) && !isFanoutStorageConstraint(error, producers)) {
      throw error;
    }
    // Lost race: observe the winner. Terminal replays, running
    // holds, still-pending reads stale (the world moved; re-drive).
    const reloaded = await opts.store.load(T34F7_FANOUT_CHILD_MODEL, key as RecordId);
    if (reloaded === null) {
      throw new Error("t34-f7: claim: child row vanished under a claim race.");
    }
    const reloadedData = producers.tables.readFanoutChildRow(reloaded);
    const replayed = fanoutChildOutcomeFromData(reloadedData);
    if (replayed !== null) {
      return { status: "replayed", outcome: replayed, row: reloaded };
    }
    if (reloadedData.state === "running") {
      return { status: "held", row: reloaded, child: opts.child };
    }
    return { status: "refused-stale", row: reloaded, child: opts.child };
  }
  return { status: "claimed", row: running, child: opts.child };
}

/** T34-F7: one durable record request against a running (claimed) child. */
export interface RecordFanoutChildAttemptOpts {
  readonly store: StoragePort;
  readonly child: FanoutChildId;
  readonly result: FanoutChildAttemptResult;
  /** Claim/record instant as UTC epoch ms (also anchors the horizon check). */
  readonly nowMs: number;
  /** Explicit per-call bounds (no default, no quota field). */
  readonly policy: RetryPolicy;
  readonly meta: FanoutRowMeta;
  readonly producers?: FanoutStateProducers;
}

/** T34-F7: durable record outcome (F3-identical statuses and shapes). */
export type FanoutChildRecordOutcome =
  /** Terminal recorded (completed/skipped/failed incl. exhausted dead-letter). */
  | { readonly status: "recorded"; readonly outcome: FanoutChildOutcome; readonly row: StoredRow }
  /** Transient within budget: back to pending, attempts++ on the same row. */
  | { readonly status: "retried"; readonly row: StoredRow }
  /** Already terminal: recorded outcome replayed, minting nothing. */
  | { readonly status: "replayed"; readonly outcome: FanoutChildOutcome; readonly row: StoredRow };

/**
 * T34-F7: record one executed attempt durably — terminal replays,
 * live-but-idle throws (record needs a running claim), then
 * completed/skipped/failed record terminally (outcome + checkpoint
 * advance in ONE linkage-asserted batch) while transient retries
 * within budget or exhausts to failed/exhausted (F3-exact: attempt
 * cap OR time horizon; attempts++ on the same row identity).
 *
 * The retry horizon anchors at `fanoutFirstAttemptAnchor` (the child
 * row's durable `created` — the F3/F5-owed seam): crash-stable,
 * enforced from durable truth. NOTE (advance divergence, not a
 * mirror): the checkpoint advance stages ONLY for terminal records —
 * `outcome.ts` covers terminal children, and the join assertion
 * refuses a checkpoint update without its terminal outcome.
 *
 * Races: a version-conflicted record against a now-terminal row
 * replays the winner; anything still live rethrows (single-shot —
 * callers decide; fence conflicts always propagate).
 */
export async function recordFanoutChildAttempt(
  opts: RecordFanoutChildAttemptOpts,
): Promise<FanoutChildRecordOutcome> {
  const producers = opts.producers ?? (await loadFanoutStateProducers());
  checkFanoutRowMeta(opts.meta, "record");
  checkFanoutPolicy(opts.policy, "record");
  checkFanoutAttemptResult(opts.result);
  if (!Number.isFinite(opts.nowMs) || opts.nowMs < 0) {
    throw new Error("t34-f7: record needs nowMs as finite epoch ms >= 0.");
  }
  producers.cohort.checkFanoutChildId(opts.child);
  const key = producers.tables.fanoutChildRowId(
    opts.child.parentOccurrence,
    opts.child.handler,
    opts.child.recordId,
  );
  const current = await opts.store.load(T34F7_FANOUT_CHILD_MODEL, key as RecordId);
  if (current === null) {
    throw new Error(`t34-f7: no fanout child row for ${JSON.stringify(key)} (producer write missing).`);
  }
  const data = producers.tables.readFanoutChildRow(current);
  const terminal = fanoutChildOutcomeFromData(data);
  if (terminal !== null) {
    return { status: "replayed", outcome: terminal, row: current };
  }
  if (data.state !== "running") {
    throw new Error(
      `t34-f7: record applies to running children only; ${JSON.stringify(key)} is ${data.state}.`,
    );
  }
  const staged = producers.outcome.stageFanoutChildOutcomeWrite({
    row: current,
    result: opts.result,
    nowMs: opts.nowMs,
    firstAttemptAtMs: fanoutFirstAttemptAnchor(current),
    policy: opts.policy,
    meta: opts.meta,
  });
  const writes: DomainWrite[] = [staged.write];
  if (staged.terminal) {
    const checkpointRow = await opts.store.load(
      T34F7_FANOUT_CHECKPOINT_MODEL,
      data.fanoutId as RecordId,
    );
    if (checkpointRow === null) {
      throw new Error("t34-f7: record: checkpoint row missing for a terminal record.");
    }
    const checkpoint = producers.tables.readFanoutCheckpointRow(checkpointRow);
    writes.push(
      producers.outcome.stageFanoutCheckpointAdvanceWrite({
        row: checkpointRow,
        recordId: staged.recordId,
        cursor: checkpoint.cursor,
        meta: opts.meta,
      }),
    );
  }
  const batch: CommitBatch = {
    expectedRevision: await opts.store.readRevision(),
    writes,
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
  producers.join.assertFanoutChildJoin(batch);
  try {
    await opts.store.commit(batch);
  } catch (error) {
    if (fanoutStateErrorCode(error) !== null) throw error;
    if (isFanoutFenceConflict(error, producers)) throw error;
    if (!isFanoutStorageConstraint(error, producers)) throw error;
    const reloaded = await opts.store.load(T34F7_FANOUT_CHILD_MODEL, key as RecordId);
    if (reloaded === null) {
      throw new Error("t34-f7: record: child row vanished under a record race.");
    }
    const replayed = fanoutChildOutcomeFromData(producers.tables.readFanoutChildRow(reloaded));
    if (replayed === null) throw error;
    return { status: "replayed", outcome: replayed, row: reloaded };
  }
  if (!staged.terminal) {
    return { status: "retried", row: staged.row };
  }
  const stagedData = producers.tables.readFanoutChildRow(staged.row);
  return {
    status: "recorded",
    outcome: fanoutTerminalOrThrow(staged.row, stagedData, "recorded"),
    row: staged.row,
  };
}

/* -- T34-F7 fair resumable scheduler. -- */

/** T34-F7: one bounded stale-claim release request. */
export interface ReleaseStaleFanoutClaimsOpts {
  readonly store: StoragePort;
  readonly fanoutId: string;
  /** Last-seen child row id (exclusive lower bound); null starts at the head. */
  readonly cursor: string | null;
  /** Page transport bound (chunk size, never cohort size). */
  readonly limit: number;
  readonly nowMs: number;
  readonly maxClaimAgeMs: number;
  readonly meta: FanoutRowMeta;
  readonly producers?: FanoutStateProducers;
}

/** T34-F7: one bounded stale-claim release outcome. */
export interface ReleaseStaleFanoutClaimsResult {
  /** Released child row ids (running -> pending, attempts unchanged). */
  readonly released: ReadonlyArray<string>;
  /** Rows skipped under contention (rival touched them; next sweep re-observes). */
  readonly skipped: ReadonlyArray<{ readonly childId: string; readonly reason: string }>;
  readonly cursor: string | null;
  readonly done: boolean;
}

/**
 * T34-F7: release running children whose claim is provably stale
 * (F4 `resume` posture: `updated` + max age <= now, boundary
 * inclusive) back to pending for re-drive. Per-row fenced commits
 * (fresh revision each) so one contended row never blocks the rest;
 * conflicts report as skipped, never forced. Attempts unchanged
 * (a release is not an attempt); fresh/uncertain claims are
 * untouched (a live worker may hold them).
 */
export async function releaseStaleFanoutClaims(
  opts: ReleaseStaleFanoutClaimsOpts,
): Promise<ReleaseStaleFanoutClaimsResult> {
  const producers = opts.producers ?? (await loadFanoutStateProducers());
  checkFanoutRowMeta(opts.meta, "release");
  if (typeof opts.fanoutId !== "string" || opts.fanoutId === "") {
    throw new Error("t34-f7: release needs a non-empty fanout id.");
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new Error("t34-f7: release needs limit as an integer >= 1.");
  }
  if (!Number.isFinite(opts.nowMs) || opts.nowMs < 0) {
    throw new Error("t34-f7: release needs nowMs as finite epoch ms >= 0.");
  }
  if (!Number.isFinite(opts.maxClaimAgeMs) || opts.maxClaimAgeMs < 0) {
    throw new Error("t34-f7: release needs maxClaimAgeMs as finite ms >= 0.");
  }
  const query = producers.tables.fanoutChildPageQuery(opts.fanoutId, {
    cursor: opts.cursor,
    limit: opts.limit,
  });
  const page = producers.tables.fanoutChildPageResult(await opts.store.query(query), opts.limit);
  const released: string[] = [];
  const skipped: { readonly childId: string; readonly reason: string }[] = [];
  for (const row of page.rows) {
    const data = producers.tables.readFanoutChildRow(row);
    if (data.state !== "running") continue;
    if (!isFanoutRowClaimStale(row.updated, opts.nowMs, opts.maxClaimAgeMs)) continue;
    const back = producers.tables.withFanoutRowData(
      row,
      { ...data, state: "pending" },
      opts.meta,
    );
    try {
      await opts.store.commit({
        expectedRevision: await opts.store.readRevision(),
        writes: [
          {
            kind: "update",
            model: T34F7_FANOUT_CHILD_MODEL,
            id: row.id,
            expectedVersion: row.version,
            row: back,
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
    } catch (error) {
      if (fanoutStateErrorCode(error) !== null) throw error;
      if (!isFanoutFenceConflict(error, producers) && !isFanoutStorageConstraint(error, producers)) {
        throw error;
      }
      skipped.push({ childId: data.childId, reason: "contention" });
      continue;
    }
    released.push(data.childId);
  }
  released.sort();
  skipped.sort((a, b) => (a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0));
  return { released, skipped, cursor: page.cursor, done: page.done };
}

/** T34-F7: lifecycle shape for one scheduler turn (cohort model + anchor). */
export interface FanoutSchedulerCohort {
  readonly model: string;
  /** Pinned anchor for anchored-collection cohorts (moved detection). */
  readonly anchor?: { readonly model: string; readonly id: string };
}

/** T34-F7: admission-completion freeze for one scheduler turn (idempotent replay). */
export interface FanoutSchedulerFreeze {
  readonly cutoff: FanoutCutoffSpec;
  readonly cohort: FanoutCohortSpec;
  readonly owner: string;
  readonly bounds: {
    readonly pageLimit: number;
    readonly chunkSize: number;
    readonly maxAttempts: number;
  };
  readonly hasModel?: (model: string) => boolean;
}

/** T34-F7: child-body effects (staged domain truth + the attempt result). */
export interface FanoutSchedulerBodyEffects {
  readonly writes: ReadonlyArray<DomainWrite>;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly outbox: ReadonlyArray<OutboxIntent>;
  readonly schedules: ReadonlyArray<ScheduleOp>;
  readonly result: FanoutChildAttemptResult;
}

/**
 * T34-F7: attempt identity handed to the child body for effect
 * attribution.
 */
export interface FanoutSchedulerBodyAttempt {
  /**
   * The attempt's invoking operation id (=== ctx.operationId at the
   * unit commit): body-staged outbox intents and history entries
   * MUST carry this id — state staging forbids cross-operation
   * attribution.
   */
  readonly operationId: string;
}

/**
 * T34-F7: injected child-body port (the deployed handler stages the
 * child's domain effects and returns the attempt result; a
 * `StateError` throw with code `rule_failed` is the business
 * rejection). Called only for claimed children — pins never invoke.
 * The attempt carries the invoking operation id so staged effects
 * attribute to this attempt (C1: bodies cannot guess it).
 */
export type FanoutSchedulerBodyPort = (
  child: FanoutChildId,
  domainRow: StoredRow,
  attempt: FanoutSchedulerBodyAttempt,
) => FanoutSchedulerBodyEffects | Promise<FanoutSchedulerBodyEffects>;

/** T34-F7: canonical-invoke inputs for executed children (all pass-through). */
export interface FanoutSchedulerInvoke {
  readonly registry: unknown;
  readonly memberships: unknown;
  readonly clock: { nowMs(): number };
  readonly identity: ResolvedIdentity;
  readonly app: string;
  readonly source: string;
  readonly childOperation: string;
  /** Child record ref input name in the def (the version-fenced ref). */
  readonly refInput: string;
  /** Fresh uuidv7 attempt identity, caller-minted per attempt. */
  readonly operationIdFor: (child: FanoutChildId) => string;
}

/** T34-F7: explicit scheduler-turn bounds (no defaults, no quota field). */
export interface FanoutSchedulerTurnBounds {
  /** Child-page transport bound (chunk size, never cohort size). */
  readonly pageLimit: number;
  /** Max children driven (claim-or-pin) in this turn. */
  readonly maxDrives: number;
}

/** T34-F7: one fair scheduler turn request. */
export interface RunFanoutSchedulerTurnOpts {
  readonly store: StoragePort;
  readonly fanoutId: string;
  readonly cursor: string | null;
  readonly bounds: FanoutSchedulerTurnBounds;
  readonly policy: RetryPolicy;
  readonly meta: FanoutRowMeta;
  readonly maxClaimAgeMs: number;
  /** Cohort shape for lifecycle classification + domain reads. */
  readonly cohort: FanoutSchedulerCohort;
  /** Admission completion (freeze replay); absent skips admission. */
  readonly freeze?: FanoutSchedulerFreeze;
  /** Claim-time dispatch guard (null predicate means unconditional). */
  readonly guard: { readonly predicate: string | null; readonly frozenInputs: unknown };
  readonly evaluateGuard: (
    predicate: string,
    frozenInputs: unknown,
    stateSnapshot: unknown,
  ) => boolean;
  /** CURRENT snapshot per child (after the row load, before the guard). */
  readonly readSnapshot: (child: FanoutChildId, domainRow: StoredRow) => unknown | Promise<unknown>;
  /** Fresh claim-time fence per child (owner + optional trigger + live revalidation). */
  readonly fenceFor: (child: FanoutChildId) => FanoutClaimFenceInput;
  readonly body: FanoutSchedulerBodyPort;
  readonly invoke: FanoutSchedulerInvoke;
  readonly producers?: FanoutStateProducers;
}

/** T34-F7: one driven child within a turn. */
export interface FanoutTurnDrivenChild {
  readonly childId: string;
  readonly recordId: string;
  readonly status: "replayed" | "held" | "recorded" | "pinned" | "refused" | "stale" | "retry";
  /** Closed detail (terminal state/reason, hold/replay cause, retry cause). */
  readonly detail: string;
}

/** T34-F7: one fair scheduler turn outcome. */
export type FanoutSchedulerTurnResult =
  | {
      readonly status: "turn";
      readonly driven: ReadonlyArray<FanoutTurnDrivenChild>;
      readonly released: ReadonlyArray<string>;
      readonly releaseSkipped: ReadonlyArray<{ readonly childId: string; readonly reason: string }>;
      /** Resume cursor when done:false; null when done:true. */
      readonly cursor: string | null;
      /** True only when the page exhausted (re-sweep while work remains). */
      readonly done: boolean;
      readonly progress: FanoutProgress;
    }
  | {
      readonly status: "diagnosed";
      readonly diagnosis: FanoutCohortDiagnosis;
      /** Null when the intent row is missing (no invented progress). */
      readonly progress: FanoutProgress | null;
    };

/**
 * T34-F7: drive one child row within a turn (F5-driver order with the
 * F3 claim seam: terminal -> replay; running -> hold; lifecycle
 * deleted/unknown -> pin without invoking; domain-race -> reclassify
 * once; claim (guard-on-current inside, fresh fence inside) ->
 * pins/held/replay/stale report, claimed invokes through the REAL
 * `invokeFanoutChild` fresh-fence unit commit).
 */
async function driveFanoutTurnChild(input: {
  readonly store: StoragePort;
  readonly childRow: StoredRow;
  readonly cohort: FanoutSchedulerCohort;
  readonly guard: { readonly predicate: string | null; readonly frozenInputs: unknown };
  readonly evaluateGuard: (
    predicate: string,
    frozenInputs: unknown,
    stateSnapshot: unknown,
  ) => boolean;
  readonly readSnapshot: (child: FanoutChildId, domainRow: StoredRow) => unknown | Promise<unknown>;
  readonly fenceFor: (child: FanoutChildId) => FanoutClaimFenceInput;
  readonly body: FanoutSchedulerBodyPort;
  readonly invoke: FanoutSchedulerInvoke;
  readonly policy: RetryPolicy;
  readonly meta: FanoutRowMeta;
  readonly producers: FanoutStateProducers;
}): Promise<FanoutTurnDrivenChild> {
  const { store, childRow, cohort, producers, policy, meta } = input;
  const data = producers.tables.readFanoutChildRow(childRow);
  const child: FanoutChildId = {
    parentOccurrence: data.parentOccurrence,
    handler: data.handler,
    recordId: data.recordId,
  };
  const terminal = fanoutChildOutcomeFromData(data);
  if (terminal !== null) {
    const detail =
      terminal.state === "completed"
        ? "completed"
        : terminal.cause.kind === "skipped" || terminal.cause.kind === "failed"
          ? `${terminal.state}/${terminal.cause.reason}`
          : terminal.state;
    return { childId: data.childId, recordId: data.recordId, status: "replayed", detail };
  }
  if (data.state === "running") {
    return { childId: data.childId, recordId: data.recordId, status: "held", detail: "running-held" };
  }
  // F1 `FanoutChildCause` is closed (completed | skipped+reason |
  // failed+reason): past the completed check the reason always exists.
  const pinDetail = (outcome: FanoutChildOutcome): string =>
    outcome.cause.kind === "completed" ? "completed" : `${outcome.state}/${outcome.cause.reason}`;
  const tryPin = async (
    row: StoredRow,
    result:
      | { readonly kind: "skipped"; readonly reason: FanoutSkippedReason }
      | { readonly kind: "failed"; readonly reason: Exclude<FanoutFailedReason, "exhausted"> },
    what: string,
  ): Promise<FanoutTurnDrivenChild> => {
    try {
      const pinned = await pinFanoutChildTerminal({
        store,
        childRow: row,
        result,
        nowMs: meta.nowMs,
        policy,
        meta,
        producers,
        what,
      });
      return {
        childId: data.childId,
        recordId: data.recordId,
        status: "pinned",
        detail: pinDetail(pinned.outcome),
      };
    } catch (error) {
      if (fanoutStateErrorCode(error) !== null) throw error;
      if (!isFanoutFenceConflict(error, producers) && !isFanoutStorageConstraint(error, producers)) {
        throw error;
      }
      return { childId: data.childId, recordId: data.recordId, status: "retry", detail: "pin-contention" };
    }
  };
  const lifecycle = await producers.lifecycle.classifyFanoutChildLifecycle({
    store,
    model: cohort.model,
    recordId: data.recordId,
    ...(cohort.anchor === undefined ? {} : { anchor: cohort.anchor }),
  });
  if (lifecycle.status === "deleted") {
    return tryPin(childRow, { kind: "skipped", reason: "deleted" }, "turn pin deleted");
  }
  if (lifecycle.status === "unknown") {
    return tryPin(childRow, { kind: "failed", reason: lifecycle.reason }, "turn pin unknown");
  }
  let domainRow = await store.load(cohort.model as ModelName, data.recordId as RecordId);
  if (domainRow === null || domainRow.archivedAt !== null) {
    // Raced disposal between classification and the guard read:
    // re-classify once and pin — never execute a dead row.
    const raced = await producers.lifecycle.classifyFanoutChildLifecycle({
      store,
      model: cohort.model,
      recordId: data.recordId,
      ...(cohort.anchor === undefined ? {} : { anchor: cohort.anchor }),
    });
    if (raced.status === "deleted") {
      return tryPin(childRow, { kind: "skipped", reason: "deleted" }, "turn pin raced deleted");
    }
    if (raced.status === "unknown") {
      return tryPin(childRow, { kind: "failed", reason: raced.reason }, "turn pin raced unknown");
    }
    return { childId: data.childId, recordId: data.recordId, status: "retry", detail: "lifecycle-race" };
  }
  const snapshotFailure: { lifecycle: FanoutChildLifecycle | null } = { lifecycle: null };
  let claim: FanoutChildClaimOutcome;
  try {
    claim = await claimFanoutChild({
      store,
      child,
      snapshotVersion: childRow.version,
      guard: input.guard,
      frozenInputs: input.guard.frozenInputs,
      readCurrentSnapshot: async () => {
        let current: StoredRow | null;
        try {
          current = await store.load(cohort.model as ModelName, data.recordId as RecordId);
        } catch (error) {
          snapshotFailure.lifecycle = { status: "unknown", reason: "infra-read-failure" };
          throw error;
        }
        if (current === null || current.archivedAt !== null) {
          snapshotFailure.lifecycle = await producers.lifecycle.classifyFanoutChildLifecycle({
            store,
            model: cohort.model,
            recordId: data.recordId,
            ...(cohort.anchor === undefined ? {} : { anchor: cohort.anchor }),
          });
          throw new Error("t34-f7: turn: domain row unavailable at guard demand.");
        }
        return input.readSnapshot(child, current);
      },
      evaluateGuard: input.evaluateGuard,
      fence: input.fenceFor(child),
      policy,
      meta,
      producers,
    });
  } catch (error) {
    const raced = snapshotFailure.lifecycle;
    if (raced === null) throw error;
    if (raced.status === "deleted") {
      return tryPin(childRow, { kind: "skipped", reason: "deleted" }, "turn pin guard deleted");
    }
    if (raced.status === "unknown") {
      return tryPin(childRow, { kind: "failed", reason: raced.reason }, "turn pin guard unknown");
    }
    return { childId: data.childId, recordId: data.recordId, status: "retry", detail: "lifecycle-race" };
  }
  if (claim.status === "skipped") {
    return { childId: data.childId, recordId: data.recordId, status: "pinned", detail: pinDetail(claim.outcome) };
  }
  if (claim.status === "refused-inherited-scope" || claim.status === "refused-revoked") {
    return { childId: data.childId, recordId: data.recordId, status: "refused", detail: pinDetail(claim.outcome) };
  }
  if (claim.status === "held") {
    return { childId: data.childId, recordId: data.recordId, status: "held", detail: "running-held" };
  }
  if (claim.status === "replayed") {
    return { childId: data.childId, recordId: data.recordId, status: "replayed", detail: pinDetail(claim.outcome) };
  }
  if (claim.status === "refused-stale") {
    return { childId: data.childId, recordId: data.recordId, status: "stale", detail: "snapshot-stale" };
  }
  // Won the claim: execute through the REAL fresh-fence unit commit.
  const operationId = input.invoke.operationIdFor(child);
  if (typeof operationId !== "string" || operationId === "") {
    throw new Error("t34-f7: turn needs a non-empty attempt operationId per executed child.");
  }
  const claimedRow = claim.row;
  void claimedRow;
  const execute = async (call: FanoutAdmittedCall): Promise<{
    readonly writes: ReadonlyArray<DomainWrite>;
    readonly history: ReadonlyArray<HistoryEntry>;
    readonly outbox: ReadonlyArray<OutboxIntent>;
    readonly schedules: ReadonlyArray<ScheduleOp>;
    readonly uniqueClaims: ReadonlyArray<UniqueClaim>;
    readonly uniqueReleases: ReadonlyArray<UniqueRelease>;
    readonly resolvedDefaults: Record<string, unknown>;
    readonly result: unknown;
  }> => {
    if (!isUnknownRecord(call) || !Array.isArray(call.recordRefs)) {
      throw new Error("t34-f7: turn: execution needs admitted record refs.");
    }
    const refs = call.recordRefs.filter(ref =>
      isUnknownRecord(ref) && ref.param === input.invoke.refInput && ref.model === cohort.model &&
      ref.id === data.recordId && isUnknownRecord(ref.row) && ref.row.id === data.recordId);
    if (refs.length !== 1) {
      throw new Error("t34-f7: turn: execution needs exactly one admitted child record ref.");
    }
    const effects = await input.body(child, refs[0]!.row, { operationId });
    checkFanoutAttemptResult(effects.result);
    // Fresh fanout rows per execution (invoke retries re-execute, so
    // versions re-read — never carried across attempts).
    const childNow = await store.load(T34F7_FANOUT_CHILD_MODEL, childRow.id);
    const checkpointNow = await store.load(
      T34F7_FANOUT_CHECKPOINT_MODEL,
      data.fanoutId as RecordId,
    );
    if (childNow === null || checkpointNow === null) {
      throw new Error("t34-f7: turn: fanout rows vanished before the unit commit.");
    }
    const staged = producers.outcome.stageFanoutChildOutcomeWrite({
      row: childNow,
      result: effects.result,
      nowMs: meta.nowMs,
      firstAttemptAtMs: fanoutFirstAttemptAnchor(childNow),
      policy,
      meta,
    });
    // The checkpoint advance stages ONLY for terminal records (the
    // join assertion refuses a checkpoint update without its
    // terminal outcome); transient records commit outcome-only.
    const advance = staged.terminal
      ? [
          producers.outcome.stageFanoutCheckpointAdvanceWrite({
            row: checkpointNow,
            recordId: staged.recordId,
            cursor: producers.tables.readFanoutCheckpointRow(checkpointNow).cursor,
            meta,
          }),
        ]
      : [];
    return {
      writes: [...effects.writes, staged.write, ...advance],
      history: [...effects.history],
      outbox: [...effects.outbox],
      schedules: [...effects.schedules],
      uniqueClaims: [],
      uniqueReleases: [],
      resolvedDefaults: {},
      result: { child: data.recordId },
    };
  };
  try {
    await producers.invoke.invokeFanoutChild({
      registry: input.invoke.registry,
      store,
      memberships: input.invoke.memberships,
      clock: input.invoke.clock,
      childOperation: input.invoke.childOperation,
      child,
      operationId,
      identity: input.invoke.identity,
      app: input.invoke.app,
      source: input.invoke.source,
      inputs: { [input.invoke.refInput]: { id: data.recordId } },
      execute,
      assertJoin: producers.join.assertFanoutChildJoin,
    });
  } catch (error) {
    const code = fanoutStateErrorCode(error);
    if (code === "busy" || code === "conflict") {
      // Contention: the claim stays held and ages out through the
      // stale-claim path; the child re-drives next sweep.
      return { childId: data.childId, recordId: data.recordId, status: "retry", detail: code };
    }
    if (code === "forbidden") {
      // Claim-time T32 refusal: back to pending first (one plain
      // commit — claims carry no completion), then pin terminal
      // failed/inaccessible-record with the checkpoint (F5-exact).
      // Attempts unchanged throughout — the claim never executed.
      const refused = await store.load(T34F7_FANOUT_CHILD_MODEL, childRow.id);
      if (refused === null) {
        throw new Error("t34-f7: turn: child row vanished after a refusal.");
      }
      const refusedData = producers.tables.readFanoutChildRow(refused);
      const already = fanoutChildOutcomeFromData(refusedData);
      if (already !== null) {
        return { childId: data.childId, recordId: data.recordId, status: "replayed", detail: pinDetail(already) };
      }
      const back = producers.tables.withFanoutRowData(
        refused,
        { ...refusedData, state: "pending" },
        meta,
      );
      try {
        await store.commit({
          expectedRevision: await store.readRevision(),
          writes: [
            {
              kind: "update",
              model: T34F7_FANOUT_CHILD_MODEL,
              id: refused.id,
              expectedVersion: refused.version,
              row: back,
            },
          ],
          history: [],
          receipt: null,
          outbox: [],
          schedules: [],
          uniqueClaims: [],
          uniqueReleases: [],
        });
      } catch (backError) {
        if (fanoutStateErrorCode(backError) !== null) throw backError;
        if (!isFanoutFenceConflict(backError, producers) && !isFanoutStorageConstraint(backError, producers)) {
          throw backError;
        }
        return { childId: data.childId, recordId: data.recordId, status: "retry", detail: "refusal-contention" };
      }
      const pinned = await pinFanoutChildTerminal({
        store,
        childRow: back,
        result: {
          kind: "failed",
          reason: producers.outcome.FANOUT_T32_REFUSAL_REASON as Exclude<FanoutFailedReason, "exhausted">,
        },
        nowMs: meta.nowMs,
        policy,
        meta,
        producers,
        what: "turn pin refused",
      });
      return { childId: data.childId, recordId: data.recordId, status: "refused", detail: pinDetail(pinned.outcome) };
    }
    if (code === "rule_failed") {
      // Business rejection: the rejected attempt committed no child
      // effects; pin running -> failed/business-rejection (the
      // rejected attempt counts — F5-exact).
      const rejected = await store.load(T34F7_FANOUT_CHILD_MODEL, childRow.id);
      if (rejected === null) {
        throw new Error("t34-f7: turn: child row vanished after a rejection.");
      }
      const rejectedData = producers.tables.readFanoutChildRow(rejected);
      const already = fanoutChildOutcomeFromData(rejectedData);
      if (already !== null) {
        return { childId: data.childId, recordId: data.recordId, status: "replayed", detail: pinDetail(already) };
      }
      return tryPin(rejected, { kind: "failed", reason: "business-rejection" }, "turn pin rejected");
    }
    throw error;
  }
  const recorded = await store.load(T34F7_FANOUT_CHILD_MODEL, childRow.id);
  if (recorded === null) {
    throw new Error("t34-f7: turn: child row vanished after its unit commit.");
  }
  const recordedData = producers.tables.readFanoutChildRow(recorded);
  const outcome = fanoutChildOutcomeFromData(recordedData);
  return {
    childId: data.childId,
    recordId: data.recordId,
    status: "recorded",
    detail: outcome === null ? "retried-pending" : pinDetail(outcome),
  };
}

/**
 * T34-F7: run one fair scheduler turn — admission completion (freeze
 * replay when `freeze` is present; a diagnosis returns before any
 * drive), one bounded stale-release pass, one bounded child page
 * with at most maxDrives drives in id-sorted order (claim ->
 * fresh-fence invoke -> record), and operator progress.
 *
 * Fairness (§C9/M8): id-sorted order, every admitted identity driven
 * exactly once per sweep, retries return to pending under the same
 * id and re-drive on later sweeps — no stalled child starves the
 * rest. Resumability: `cursor`/`done` chain turns within a sweep;
 * a new sweep restarts at null (retries behind the cursor are
 * picked up there); crash resumes purely from durable truth
 * (terminal replays, fresh claims hold, stale claims release).
 * Chunk size (`pageLimit`/`maxDrives`) bounds one turn only — never
 * the cohort: varying it visits identical sets (proven through the
 * real path).
 */
export async function runFanoutSchedulerTurn(
  opts: RunFanoutSchedulerTurnOpts,
): Promise<FanoutSchedulerTurnResult> {
  const producers = opts.producers ?? (await loadFanoutStateProducers());
  checkFanoutRowMeta(opts.meta, "turn");
  checkFanoutPolicy(opts.policy, "turn");
  if (typeof opts.fanoutId !== "string" || opts.fanoutId === "") {
    throw new Error("t34-f7: turn needs a non-empty fanout id.");
  }
  if (!Number.isInteger(opts.bounds.pageLimit) || opts.bounds.pageLimit < 1) {
    throw new Error("t34-f7: turn needs bounds.pageLimit as an integer >= 1.");
  }
  if (!Number.isInteger(opts.bounds.maxDrives) || opts.bounds.maxDrives < 1) {
    throw new Error("t34-f7: turn needs bounds.maxDrives as an integer >= 1.");
  }
  if (!Number.isFinite(opts.maxClaimAgeMs) || opts.maxClaimAgeMs < 0) {
    throw new Error("t34-f7: turn needs maxClaimAgeMs as finite ms >= 0.");
  }
  checkClosedText(opts.cohort.model, "turn cohort model");
  if (typeof opts.evaluateGuard !== "function" || typeof opts.readSnapshot !== "function") {
    throw new Error("t34-f7: turn needs evaluateGuard + readSnapshot functions.");
  }
  if (typeof opts.fenceFor !== "function" || typeof opts.body !== "function") {
    throw new Error("t34-f7: turn needs fenceFor + body functions.");
  }
  checkClosedText(opts.invoke.childOperation, "turn child operation");
  checkClosedText(opts.invoke.refInput, "turn ref input");
  if (typeof opts.invoke.operationIdFor !== "function") {
    throw new Error("t34-f7: turn needs an operationIdFor function.");
  }
  if (opts.freeze !== undefined) {
    const freeze = opts.freeze;
    const admitted = await producers.membership.freezeFanoutMembership({
      store: opts.store,
      cutoff: freeze.cutoff,
      cohort: freeze.cohort,
      owner: freeze.owner,
      bounds: freeze.bounds,
      meta: opts.meta,
      ...(freeze.hasModel === undefined ? {} : { hasModel: freeze.hasModel }),
    });
    if (!admitted.ok) {
      let progress: FanoutProgress | null = null;
      try {
        progress = await producers.progress.readFanoutProgress({
          store: opts.store,
          fanoutId: opts.fanoutId,
          pageLimit: opts.bounds.pageLimit,
        });
      } catch {
        progress = null;
      }
      return { status: "diagnosed", diagnosis: admitted.diagnosis, progress };
    }
  }
  const released = await releaseStaleFanoutClaims({
    store: opts.store,
    fanoutId: opts.fanoutId,
    cursor: opts.cursor,
    limit: opts.bounds.pageLimit,
    nowMs: opts.meta.nowMs,
    maxClaimAgeMs: opts.maxClaimAgeMs,
    meta: opts.meta,
    producers,
  });
  const query = producers.tables.fanoutChildPageQuery(opts.fanoutId, {
    cursor: opts.cursor,
    limit: opts.bounds.pageLimit,
  });
  const page = producers.tables.fanoutChildPageResult(
    await opts.store.query(query),
    opts.bounds.pageLimit,
  );
  const driven: FanoutTurnDrivenChild[] = [];
  const batch = page.rows.slice(0, opts.bounds.maxDrives);
  for (const childRow of batch) {
    driven.push(
      await driveFanoutTurnChild({
        store: opts.store,
        childRow,
        cohort: opts.cohort,
        guard: opts.guard,
        evaluateGuard: opts.evaluateGuard,
        readSnapshot: opts.readSnapshot,
        fenceFor: opts.fenceFor,
        body: opts.body,
        invoke: opts.invoke,
        policy: opts.policy,
        meta: opts.meta,
        producers,
      }),
    );
  }
  // Honest resume: a maxDrives-truncated page resumes after the last
  // PROCESSED row (never past unprocessed ones); a fully processed
  // page carries the store page signal.
  let cursor: string | null;
  let done: boolean;
  if (batch.length < page.rows.length) {
    const last = batch[batch.length - 1];
    if (last === undefined) {
      throw new Error("t34-f7: unreachable: truncated batch has no last row.");
    }
    cursor = last.id as string;
    done = false;
  } else {
    cursor = page.cursor;
    done = page.done;
  }
  const progress = await producers.progress.readFanoutProgress({
    store: opts.store,
    fanoutId: opts.fanoutId,
    pageLimit: opts.bounds.pageLimit,
  });
  return {
    status: "turn",
    driven,
    released: released.released,
    releaseSkipped: released.skipped,
    cursor,
    done,
    progress,
  };
}

/* -- T34-F7 operator progress + provider cancellation. -- */

/**
 * T34-F7: read one fanout's data-minimized operator progress (the
 * REAL F5 `readFanoutProgress`: counts only, terminal-with-failures
 * means attention, missing rows read pending — never complete).
 */
export async function readFanoutSchedulerProgress(opts: {
  readonly store: StoragePort;
  readonly fanoutId: string;
  readonly pageLimit: number;
  readonly producers?: FanoutStateProducers;
}): Promise<FanoutProgress> {
  const producers = opts.producers ?? (await loadFanoutStateProducers());
  return producers.progress.readFanoutProgress({
    store: opts.store,
    fanoutId: opts.fanoutId,
    pageLimit: opts.pageLimit,
  });
}

/**
 * T34-F7: provider cancellation port — present ONLY when the
 * provider's accepted contract offers cancellation. The token is
 * provider-defined (opaque here); the answer is shape-checked
 * fail-closed.
 */
export type FanoutProviderCancelFn = (token: unknown) => unknown | Promise<unknown>;

/** T34-F7: one provider-cancellation request (no store: never touches rows). */
export interface RequestFanoutProviderCancelOpts {
  /**
   * The provider's accepted cancellation entry, or absent when the
   * provider contract offers none (explicit refusal — never silent,
   * never forced).
   */
  readonly cancel?: FanoutProviderCancelFn;
  readonly token?: unknown;
}

/** T34-F7: provider-cancellation outcome (M8: no promise beyond the accepted contract). */
export type RequestFanoutProviderCancelOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "cancel-failed"; readonly reason: string };

/**
 * T34-F7: request provider cancellation ONLY per its accepted
 * contract. Without a `cancel` entry the request refuses explicitly
 * (`no-cancel-contract`); with one the provider's own verdict
 * routes back. The scheduler NEVER marks provider-accepted work
 * unilaterally and NEVER writes child rows here (structurally: no
 * store parameter) — cancellation of a pending/running child row
 * would be suppression, which the adopted contract forbids (§C8).
 */
export async function requestFanoutProviderCancel(
  opts: RequestFanoutProviderCancelOpts,
): Promise<RequestFanoutProviderCancelOutcome> {
  if (opts.cancel === undefined) {
    return {
      status: "refused",
      reason: "no-cancel-contract: the provider accepted no cancellation contract.",
    };
  }
  if (typeof opts.cancel !== "function") {
    throw new Error("t34-f7: provider cancel entry must be a function.");
  }
  const answer: unknown = await opts.cancel(opts.token);
  if (!isUnknownRecord(answer)) {
    throw new Error("t34-f7: provider cancel answer must be an object.");
  }
  if (answer["cancelled"] === true) return { status: "cancelled" };
  if (answer["cancelled"] === false) {
    const reason: unknown = answer["reason"];
    if (typeof reason !== "string" || reason === "") {
      throw new Error("t34-f7: provider cancel-failed answer needs a non-empty reason.");
    }
    return { status: "cancel-failed", reason };
  }
  throw new Error("t34-f7: provider cancel answer needs a boolean cancelled.");
}
