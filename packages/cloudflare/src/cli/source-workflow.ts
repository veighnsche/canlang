/** Public source-file workflows compose generation controls and the existing app gate. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverGeneratedClosure, snapshotGeneratedClosure } from "../generation/native-capture.js";
import { runAppAcceptance, type AppAcceptanceGate } from "../generation/acceptance.js";
import { loadSettings, resolveRecipe } from "../generation/config.js";
import { defaultCompilerCaller, dispatchControl, type ControlContext, type ControlResult } from "../generation/controls.js";
import { parseUnitRecord, sha256HexBytes, validateUnitId } from "../generation/records.js";
import type { ConsumedInput } from "../generation/journal.js";

export interface SourceWorkflowArgs {
  command: "generate" | "validate";
  file: string;
  retry: boolean;
  dryRun: boolean;
  format: "json" | "text";
  /** Public CLI paths are resolved against the invoking working directory. */
  settings?: string;
}

export function parseSourceWorkflow(command: "generate" | "validate", argv: string[]): SourceWorkflowArgs {
  let file: string | undefined, retry = false, dryRun = false, format: "json" | "text" = "text";
  let hasFormat = false;
  let settings: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--retry" && command === "generate" && !retry) retry = true;
    else if (arg === "--dry-run" && command === "generate" && !dryRun) dryRun = true;
    else if ((arg === "--settings" || arg.startsWith("--settings=")) && command === "generate" && settings === undefined) {
      const value = arg === "--settings" ? argv[++index] : arg.slice(11);
      if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error("--settings requires a non-empty PATH");
      settings = resolve(value);
    }
    else if (arg.startsWith("--format=") && !hasFormat && ["json", "text"].includes(arg.slice(9))) {
      format = arg.slice(9) as "json" | "text"; hasFormat = true;
    } else if (!arg.startsWith("-") && file === undefined) file = arg;
    else throw new Error(`unexpected argument ${JSON.stringify(arg)}; use can ${command === "generate" ? "gen" : command} FILE${command === "generate" ? " [--retry] [--dry-run] [--settings=PATH]" : ""} [--format=json|text]`);
  }
  if (file === undefined || !file.endsWith(".can")) throw new Error("a readable .can source file is required");
  return { command, file: resolve(file), retry, dryRun, format, ...(settings === undefined ? {} : { settings }) };
}

interface Unit {
  id?: string | null; association?: string; kind?: string; owner?: string; label?: string | null;
  prompt_changed?: boolean | null; contract?: { profile?: string | null };
}

/** Test seams replace producers, never exposed as public flags. */
export interface SourceWorkflowContext extends ControlContext {
  discover?: typeof discoverGeneratedClosure;
  snapshot?: typeof snapshotGeneratedClosure;
  control?: typeof dispatchControl;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("producer returned an invalid result");
  return value as Record<string, unknown>;
}

function failureDetail(body: Record<string, unknown>): string {
  const error = body.error === undefined ? {} : record(body.error);
  return typeof error.message === "string" ? error.message : "the compiler refused the source; repair it and rerun";
}

async function compilerRequest(ctx: SourceWorkflowContext, request: object): Promise<Record<string, unknown>> {
  const result = await (ctx.compiler ?? defaultCompilerCaller)(JSON.stringify(request));
  const body = record(JSON.parse(result.stdout));
  if (result.code !== 0 || body.ok !== true) throw new Error(failureDetail(body));
  return body;
}

function unitsFrom(status: Record<string, unknown>): Unit[] {
  if (!Array.isArray(status.units)) throw new Error("compiler status lacks its generation units; rebuild the compiler");
  return status.units.map(value => record(value) as Unit);
}

function ensureSaved(units: Unit[]): void {
  for (const unit of units) {
    if (unit.association === "orphaned") continue;
    if (unit.association !== "retained" || typeof unit.id !== "string") {
      throw new Error(`${unit.owner ?? "source"}/${unit.kind ?? "unit"}/${unit.label ?? "inline"} has ${unit.association ?? "unknown"} saved association; run can gen FILE or reconcile its binding`);
    }
    validateUnitId(unit.id);
    if (unit.prompt_changed === true) throw new Error(`saved unit ${unit.id} has a changed prompt; run can gen FILE`);
  }
}

/** Use the compiler's exact consumed closure and existing cooperative snapshot mechanism. */
async function validateSaved(args: SourceWorkflowArgs, ctx: SourceWorkflowContext, requestId: string,
  units: Unit[], workspace: string, compiler: string): Promise<Record<string, unknown>> {
  ensureSaved(units);
  const root = dirname(args.file), file = basename(args.file);
  const closure = await (ctx.discover ?? discoverGeneratedClosure)(compiler, root, args.file);
  const captured = await (ctx.snapshot ?? snapshotGeneratedClosure)(root, args.file, closure);
  const source = captured.find(input => input.path === file);
  if (source === undefined) throw new Error("source capture omitted the application");
  await mkdir(join(root, ".can/gen/validate"), { recursive: true });
  const scratch = await mkdtemp(join(root, ".can/gen/validate", "saved-"));
  const reportDir = join(root, ".can/gen/checks", requestId);
  try {
    for (const input of captured) {
      const target = resolve(scratch, input.path);
      if (relative(scratch, target).startsWith("..")) throw new Error("captured input leaves the application root");
      await mkdir(dirname(target), { recursive: true });
      let bytes = input.bytes;
      if (/^can\.generated\/[^/]+\/unit\.json$/.test(input.path)) {
        const id = input.path.split("/")[1]!;
        const unit = parseUnitRecord(bytes.toString("utf8"), id);
        // Frozen groups must resolve their owning source inside the overlay.
        if (resolve(root, unit.source.path) !== args.file) throw new Error(`saved unit ${id} belongs to a source outside the captured app`);
        unit.source.path = file;
        bytes = Buffer.from(`${JSON.stringify(unit, null, 2)}\n`);
      }
      await writeFile(target, bytes);
    }
    const frozen: ConsumedInput[] = await Promise.all(captured.map(async input => {
      const bytes = await readFile(join(scratch, input.path));
      return { path: input.path, bytes, sha256: sha256HexBytes(bytes) };
    }));
    ctx.onEvent?.("validate", `checking ${units.filter(unit => unit.association !== "orphaned").length} saved units`);
    for (const unit of units) {
      if (unit.association === "orphaned") continue;
      await compilerRequest(ctx, { version: 1, request_id: `${requestId}.${unit.id}`, operation: "validate", root: scratch, unit_id: unit.id });
    }
    const gate: AppAcceptanceGate = ctx.appAcceptance ?? runAppAcceptance;
    await gate({ root, candidateRoot: scratch, files: [file], compiler, reportDir, workspace,
      ...(ctx.onEvent === undefined ? {} : { onEvent: ctx.onEvent }) });
    for (const input of frozen) {
      if (sha256HexBytes(await readFile(join(scratch, input.path))) !== input.sha256) throw new Error("captured app inputs changed during checks; rerun validation");
    }
    // Currency includes closure membership, declarations and contribution dependencies.
    const current = await (ctx.discover ?? discoverGeneratedClosure)(compiler, root, args.file);
    if (JSON.stringify(current) !== JSON.stringify(closure)) throw new Error("saved input closure changed during checks; rerun validation");
    for (const input of captured) {
      if (sha256HexBytes(await readFile(join(root, input.path))) !== input.sha256) throw new Error("saved source or outputs changed during checks; rerun validation");
    }
    return { validated: true, units: units.filter(unit => unit.association !== "orphaned").map(unit => unit.id), report: join(reportDir, "report.json") };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function sourceWorkflow(args: SourceWorkflowArgs, ctx: SourceWorkflowContext = {}): Promise<ControlResult> {
  const root = dirname(args.file);
  const workspace = resolve(ctx.workspace ?? process.env.CAN_INSTALL_ROOT ?? process.env.CAN_TOOL_ROOT ?? fileURLToPath(new URL("../../../../", import.meta.url)));
  const compiler = process.env["CAN_COMPILER_BIN"] ?? join(workspace, "compiler/target/debug/can");
  const requestId = `source-${randomUUID()}`;
  try {
    await readFile(args.file);
    const status = await compilerRequest(ctx, { version: 1, request_id: `${requestId}.status`, operation: "status", root, files: [args.file] });
    const units = unitsFrom(status);
    if (args.dryRun) {
      const settings = await loadSettings(root, args.settings);
      const selection = units.filter(unit => unit.association !== "orphaned").map(unit => ({
        id: unit.id ?? null, owner: unit.owner, kind: unit.kind, association: unit.association,
        action: args.retry || unit.association !== "retained" || unit.prompt_changed !== false ? "generate" : "check-saved",
        recipe: resolveRecipe(settings, unit.kind === "named-trait" || unit.kind === "inline-trait" || unit.kind === "keyword" ? "given" : "frontend", unit.contract?.profile ?? null, {}),
      }));
      return { code: 0, envelope: `${JSON.stringify({ ok: true, command: args.command, file: args.file, dry_run: true, root, settings: settings?.source ?? null, selection, jobs_started: 0 })}\n` };
    }
    if (args.command === "validate") {
      const payload = await validateSaved(args, ctx, requestId, units, workspace, compiler);
      return { code: 0, envelope: `${JSON.stringify({ ok: true, command: "validate", file: args.file, ...payload })}\n` };
    }
    const operation = args.retry ? "retry" : "generate";
    const result = await (ctx.control ?? dispatchControl)(JSON.stringify({ version: 1, request_id: requestId, operation,
      root, files: [args.file], accept: true, ...(args.settings === undefined ? {} : { settings: args.settings }),
      ...(args.retry ? {} : { mode: "prepare" }) }), { ...ctx, workspace });
    const body = record(JSON.parse(result.envelope));
    const recovery = `repair the reported issue, then rerun can gen ${JSON.stringify(args.file)} --retry${args.settings === undefined ? "" : ` --settings=${JSON.stringify(args.settings)}`}`;
    if (result.code !== 0 || body.ok !== true) {
      return { code: result.code, envelope: `${JSON.stringify({ ...body, command: "generate", file: args.file, next: [recovery] })}\n` };
    }
    const reuse = body.state === "candidate" && Array.isArray(body.attempts) && body.attempts.length === 0;
    if (!reuse && body.state !== "accepted") {
      return { code: 4, envelope: `${JSON.stringify({ ...body, ok: false, command: "generate", file: args.file, error: { code: "not-accepted", message: "generation did not produce an accepted complete app; inspect the retained attempts" }, next: [recovery] })}\n` };
    }
    // Reuse has no promoted set; qualify the saved app before reporting success.
    if (reuse) {
      const fresh = unitsFrom(await compilerRequest(ctx, { version: 1, request_id: `${requestId}.reuse`, operation: "status", root, files: [args.file] }));
      const checked = await validateSaved(args, ctx, requestId, fresh, workspace, compiler);
      return { code: 0, envelope: `${JSON.stringify({ ...body, command: "generate", file: args.file, saved_validation: checked })}\n` };
    }
    return { code: result.code, envelope: `${JSON.stringify({ ...body, command: "generate", file: args.file })}\n` };
  } catch (error) {
    return { code: 4, envelope: `${JSON.stringify({ ok: false, command: args.command, file: args.file, error: { code: "source-workflow-failed", message: error instanceof Error ? error.message : String(error) }, next: ["repair the reported input or check its acceptance report, then rerun the can command"] })}\n` };
  }
}

export async function runSourceWorkflow(command: "generate" | "validate", argv: string[]): Promise<void> {
  let args: SourceWorkflowArgs;
  try { args = parseSourceWorkflow(command, argv); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--format=json")) process.stdout.write(`${JSON.stringify({ ok: false, command, error: { code: "usage", message } })}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 2; return;
  }
  const result = await sourceWorkflow(args, { onEvent: (phase, detail) => {
    if (args.format === "text") process.stderr.write(`${phase}: ${detail}\n`);
  } });
  process.exitCode = result.code;
  if (args.format === "json") process.stdout.write(result.envelope);
  else {
    const body = record(JSON.parse(result.envelope));
    if (body.ok === true) {
      process.stdout.write(`${args.dryRun ? "Planned" : args.command === "validate" || body.saved_validation !== undefined ? "Validated saved output for" : "Generated and validated"} ${args.file}\n`);
      if (args.dryRun) for (const item of body.selection as Record<string, unknown>[]) {
        const recipe = record(item.recipe);
        process.stdout.write(`  ${item.owner}/${item.kind}: ${item.action}; ${recipe.runner} ${recipe.model} ${JSON.stringify(recipe.native)}\n`);
      }
    } else {
      process.stderr.write(`${failureDetail(body)}\n`);
      if (Array.isArray(body.next)) for (const next of body.next) process.stderr.write(`${String(next)}\n`);
    }
  }
}
