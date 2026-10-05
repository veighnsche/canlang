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
 * `ctx` is the real `./context.js` shape, passed through untouched as
 * the first handler argument; this module never inspects it.
 */
import type {
  CompileArtifact,
  Membership,
  MutationResult,
  OccurrenceId,
  ResolvedIdentity,
  StoragePort,
} from "@canlang/contracts";
import type { HandlerContext } from "./context.js";
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
/* mapping, scenario-handler execution). Artifacts predating generated  */
/* descriptors (either key absent — every existing fixture) keep the    */
/* interim direct path above byte-identically; T17 retires it.          */
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
/* from identity claims) and a commit-guarded store: direct              */
/* `StoragePort` commits inside canonical execution would break the     */
/* admission fence and triple-write on retry, so the guard fails loud   */
/* naming the T17 stdlib migration instead of corrupting. Handler       */
/* failures map to rejected receipts (same rule as the assembly's       */
/* `toBusinessError`), so identical envelopes replay rejections.        */
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

/** Minimal admitted-call view the execute seams consume. */
export interface CanonicalSeamCall {
  readonly context: {
    readonly operationId: string;
    readonly actor: { readonly userId: string } | null;
    readonly team: { readonly teamId: string } | null;
  };
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

interface CanonicalStateProducers {
  readonly registry: StateRegistryProducer;
  readonly invoke: StateInvokeProducer;
  readonly crud: StateCrudProducer;
  readonly models: StateModelsProducer;
  readonly errors: StateErrorsProducer;
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

/** Load and shape-check the five state producers (fail loud, never partial). */
async function loadCanonicalStateProducers(): Promise<CanonicalStateProducers> {
  const registryMod = await loadProducerModule(STATE_REGISTRY_SPECIFIER, "state registry producer");
  const invokeMod = await loadProducerModule(STATE_INVOKE_SPECIFIER, "state invoke producer");
  const crudMod = await loadProducerModule(STATE_CRUD_SPECIFIER, "state CRUD producer");
  const modelsMod = await loadProducerModule(STATE_MODELS_SPECIFIER, "state models producer");
  const errorsMod = await loadProducerModule(STATE_ERRORS_SPECIFIER, "state errors producer");
  const loadArtifactDescriptors = requireProducerFn(
    registryMod,
    "loadArtifactDescriptors",
    "state registry producer",
  );
  const invoke = requireProducerFn(invokeMod, "invoke", "state invoke producer");
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
  return {
    registry: { loadArtifactDescriptors: loadArtifactDescriptors as StateRegistryProducer["loadArtifactDescriptors"] },
    invoke: { invoke: invoke as StateInvokeProducer["invoke"] },
    crud: { generatedCrudExecute: generatedCrudExecute as StateCrudProducer["generatedCrudExecute"] },
    models: { buildModelTableFromCanonical: buildModelTableFromCanonical as StateModelsProducer["buildModelTableFromCanonical"] },
    errors: StateError as unknown as StateErrorsProducer,
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
 * Wrap `inner` so `commit` fails LOUD with the T17 pointer while every
 * other port method delegates untouched. A scenario handler that
 * commits directly inside canonical execution would break the
 * admission fence (its writes land at newer revisions than the
 * receipt commit expects) and triple-write across the retry loop, so
 * the guard refuses instead of corrupting — no partial effects are
 * ever committed. Reads (load/query/receipts/history) stay available:
 * read-only scenarios run the full admit -> handler -> receipt path
 * today. Delegation list mirrors `withDispatchProducer`
 * (`./executors.js`); any `StoragePort` member added later must be
 * added here too (tsc enforces the return type).
 */
export function withCanonicalCommitGuard(store: StoragePort, operation: string): StoragePort {
  return {
    readRevision: () => store.readRevision(),
    load: (model, id) => store.load(model, id),
    query: (spec) => store.query(spec),
    commit: () => {
      throw new Error(
        `t16b: operation ${JSON.stringify(operation)} attempted a direct state commit ` +
          `inside canonical execution; emitted-handler writes run through the state engine ` +
          `after the T17 stdlib migration (no partial effects were committed)`,
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

/** Loaded canonical set: admission-ready registry plus the model table. */
export interface LoadedCanonicalDescriptors {
  readonly registry: ReadonlyMap<string, unknown>;
  readonly table: unknown;
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
 * Load a generated artifact's canonical set: transcribe every CRUD
 * admission gate from its emitted policy manifest, verify every
 * scenario operation links an `operation` callable, load descriptors
 * through T16a's canonical loader (whole-set rejection — unknown
 * kinds, malformed or dangling members, untranscribable gates), and
 * build the model table. Reads need no callable (the query port
 * serves them in T17). Throws precise errors; never a partial set.
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
      // Reads admit but never execute here (the invoke read-guard
      // routes them to the query port in T17).
      return "public";
    },
  });
  const table = producers.models.buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  const canonical: LoadedCanonicalDescriptors = {
    registry: loaded.registry,
    table,
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

/**
 * Scenario execute seam: run the emitted handler with a
 * live-store-wins context (caller from the ADMITTED context,
 * memberships re-read from the live reader — identity claims are
 * never trusted for authorization facts) and the commit-guarded
 * store. The admitted (normalized) inputs flow to the handler under
 * the interim projection shape (`{operation_id, inputs}`), so
 * handler contracts are unchanged. Handler failures map to REAL
 * `StateError`s (same rule as the assembly: BusinessError-shaped
 * values keep code+message, everything else is `rule_failed`), so
 * canonical invoke persists them as rejected receipts and identical
 * envelopes replay the rejection instead of re-executing.
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
  const ctx = createContext({
    caller:
      actorUserId === null
        ? { userId: "anonymous", roles: [] }
        : { userId: actorUserId, roles: grants },
    store: withCanonicalCommitGuard(opts.store, opts.operation),
    clock: opts.now,
    memberships: grants,
  });
  const outcome = await invokeWith(opts.asm, opts.artifact, opts.operation, ctx, [
    { operation_id: call.context.operationId, inputs: call.inputs },
  ]);
  if (!outcome.ok) {
    const StateError = loaded.producers.errors;
    if (isSeamBusinessErrorLike(outcome.error)) {
      throw new StateError(outcome.error.code, outcome.error.message);
    }
    const message =
      typeof outcome.error === "string" && outcome.error !== ""
        ? outcome.error
        : "The operation was rejected.";
    throw new StateError("rule_failed", message);
  }
  return {
    writes: [],
    history: [],
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
    resolvedDefaults: {},
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
