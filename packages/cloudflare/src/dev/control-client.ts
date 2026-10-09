/** JSON control adapter over the owner-only Unix session socket. */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareLocalPreviewCapture } from "./preview-inputs.js";
import { discoverDevDaemon, startDevDaemon, stopDevDaemon } from "./session-daemon.js";
import type { SingleFileCaptureRequest } from "./source-capture.js";
import {
  discoverSessionSocket,
  SessionSocketError,
  SESSION_SOCKET_PROTOCOL,
  type SessionSocketClient,
  type SessionSocketLookup,
} from "./session-socket.js";

const COMMANDS = [
  "start", "discover", "status", "check", "diagnostics", "diagnostic.detail", "construct.help", "failure.lookup", "failure.detail", "failures",
  "preview.status", "preview.open", "example.run", "example.rerun", "stop",
] as const;
type Command = typeof COMMANDS[number];
type Flag = "--root" | "--session" | "--app" | "--profile" | "--revision" |
  "--expected-revision" | "--index" | "--after" | "--limit" | "--ref" | "--capture" |
  "--source" | "--compiler" | "--catalog" | "--help-index" | "--id" | "--operation" | "--row";
const FLAGS: ReadonlySet<string> = new Set<Flag>([
  "--root", "--session", "--app", "--profile", "--revision", "--expected-revision",
  "--index", "--after", "--limit", "--ref", "--capture", "--source", "--compiler", "--catalog", "--help-index", "--id", "--operation", "--row",
]);

export type DevControlEnvelope =
  | { readonly ok: true; readonly command: string; readonly session: string | null; readonly result: unknown }
  | { readonly ok: false; readonly command: string; readonly code: string; readonly detail: string };

export interface ControlClientDependencies {
  readonly cwd: string;
  readonly discover?: (lookup: SessionSocketLookup) => Promise<SessionSocketClient>;
}

function fail(command: string, code: string, detail: string): DevControlEnvelope {
  return { ok: false, command, code, detail: detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) };
}

function help(): DevControlEnvelope {
  const required: Readonly<Record<Command, readonly string[]>> = {
    start: ["--source PATH or --capture PATH"], discover: [], status: [], check: [],
    diagnostics: ["--revision rN"], "diagnostic.detail": ["--revision rN", "--index N"],
    "construct.help": ["--revision rN", "--id can.v1.CONSTRUCT"],
    "failure.lookup": ["--ref SESSION/rN/dN"], "failure.detail": ["--ref SESSION/rN/dN"],
    failures: ["--revision rN"],
    "preview.status": [], "preview.open": [], stop: [],
    "example.run": ["--expected-revision rN"], "example.rerun": ["--ref SESSION/rN/RUN/fCASE_ENTRY"],
  };
  return {
    ok: true, command: "help", session: null,
    result: {
      schema: "can.dev.control-help.v1", protocol: SESSION_SOCKET_PROTOCOL,
      commands: COMMANDS.map(command => ({ command, required: required[command],
        session: command === "start" ? "exclusive owner for the selected source"
          : "canonical checkout and verified owner-only socket" })),
      flags: {
        start: ["--source", "--root", "--app", "--compiler", "--catalog", "--help-index", "--capture"],
        common: ["--root", "--session", "--app", "--profile"],
        check: ["--expected-revision"],
        diagnostics: ["--revision", "--after", "--limit"],
        "diagnostic.detail": ["--revision", "--index"],
        "construct.help": ["--revision", "--id"],
        "failure.lookup": ["--ref"],
        "failure.detail": ["--ref"],
        failures: ["--revision", "--after", "--limit"],
        "example.run": ["--expected-revision", "--operation", "--row"],
        "example.rerun": ["--ref"],
      },
      start_defaults: { root: "current directory", compiler: "compiler/target/debug/can",
        catalog: "packages/values/dist/catalog.json", help_index: "docs/specification/CONSTRUCT-HELP.md" },
      unavailable: [],
    },
  };
}

function parseInteger(raw: string | undefined, minimum: number): number | null {
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

async function readCaptureManifest(path: string): Promise<SingleFileCaptureRequest> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch { throw new SessionSocketError("CAPTURE_FILE_UNAVAILABLE", "capture manifest cannot be read"); }
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
    throw new SessionSocketError("INVALID_CAPTURE", "capture manifest exceeds the input limit");
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new SessionSocketError("INVALID_CAPTURE", "capture manifest is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionSocketError("INVALID_CAPTURE", "capture manifest must be an object");
  }
  const capture = value as Record<string, unknown>;
  if (typeof capture.checkoutRoot !== "string" || typeof capture.appPath !== "string" ||
      typeof capture.profile !== "string" || typeof capture.compilerPath !== "string" ||
      (capture.catalogPath !== null && typeof capture.catalogPath !== "string") ||
      typeof capture.helpIndexPath !== "string" || !Array.isArray(capture.packageInputPaths)) {
    throw new SessionSocketError("INVALID_CAPTURE", "capture manifest lacks required inputs");
  }
  return capture as unknown as SingleFileCaptureRequest;
}

async function declaredAppName(path: string): Promise<string> {
  let source: string;
  try {
    if ((await stat(path)).size > 8 * 1024 * 1024) {
      throw new SessionSocketError("INVALID_SELECTION", "source is too large for implicit app selection; pass --app");
    }
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof SessionSocketError) throw error;
    throw new SessionSocketError("SOURCE_UNAVAILABLE", "selected source cannot be read");
  }
  const matches = [...source.matchAll(/^[ \t]*app[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/gm)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new SessionSocketError("INVALID_SELECTION", "source needs one app declaration or an explicit --app");
  }
  return matches[0][1];
}

/** One envelope even when the app check itself reports source errors. */
export async function runDevControlArgv(argv: readonly string[], deps: ControlClientDependencies): Promise<DevControlEnvelope> {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    return argv.length > 1 ? fail(command, "INVALID_ARGUMENTS", "help takes no arguments") : help();
  }
  if (!COMMANDS.includes(command as Command)) return fail(command, "UNKNOWN_COMMAND", "development control command is unavailable");
  const selected = command as Command;
  const values = new Map<Flag, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !FLAGS.has(flag) || value === undefined || value.startsWith("--") || values.has(flag as Flag)) {
      return fail(command, "INVALID_ARGUMENTS", "control flags need one value and may appear once");
    }
    values.set(flag as Flag, value);
  }
  const allowed = new Set<string>(selected === "start"
    ? ["--root", "--app", "--source", "--capture", "--compiler", "--catalog", "--help-index"]
    : ["--root", "--session", "--app", "--profile"]);
  if (selected === "check" || selected === "example.run") allowed.add("--expected-revision");
  if (selected === "example.run") { allowed.add("--operation"); allowed.add("--row"); }
  if (selected === "diagnostics" || selected === "diagnostic.detail" || selected === "construct.help" || selected === "failures") allowed.add("--revision");
  if (selected === "diagnostics" || selected === "failures") { allowed.add("--after"); allowed.add("--limit"); }
  if (selected === "diagnostic.detail") allowed.add("--index");
  if (selected === "construct.help") allowed.add("--id");
  if (selected === "failure.lookup" || selected === "failure.detail" || selected === "example.rerun") allowed.add("--ref");
  if ([...values.keys()].some(flag => !allowed.has(flag))) {
    return fail(command, "INVALID_ARGUMENTS", "flag does not apply to this command");
  }
  const revision = values.get("--revision");
  const expectedRevision = values.get("--expected-revision");
  if ((selected === "diagnostics" || selected === "diagnostic.detail" || selected === "construct.help" || selected === "failures") && !/^r[1-9][0-9]*$/.test(revision ?? "")) {
    return fail(command, "REVISION_REQUIRED", "revisioned lookup needs --revision rN");
  }
  const constructId = values.get("--id");
  if (selected === "construct.help" && !/^can\.v1\.[a-z0-9_.-]{1,100}$/.test(constructId ?? "")) {
    return fail(command, "CONSTRUCT_ID_REQUIRED", "construct help needs --id can.v1.CONSTRUCT");
  }
  if (expectedRevision !== undefined && !/^r[1-9][0-9]*$/.test(expectedRevision)) {
    return fail(command, "INVALID_REVISION", "expected revision must be rN");
  }
  if (selected === "example.run" && expectedRevision === undefined) {
    return fail(command, "REVISION_REQUIRED", "example run needs --expected-revision rN");
  }
  const operation = values.get("--operation");
  const rowIndex = values.has("--row") ? parseInteger(values.get("--row"), 0) : undefined;
  if (selected === "example.run" && ((operation === undefined) !== (rowIndex === undefined) || rowIndex === null ||
      (operation !== undefined && !/^[A-Za-z_][A-Za-z0-9_.]{0,199}$/.test(operation)))) {
    return fail(command, "INVALID_ARGUMENTS", "selected example needs --operation NAME and --row N");
  }
  const ref = values.get("--ref");
  if ((selected === "failure.lookup" || selected === "failure.detail" || selected === "example.rerun") &&
      !/^[A-Za-z0-9_-]{1,64}\/r[1-9][0-9]*\/(?:d(?:0|[1-9][0-9]*)|[A-Za-z0-9_-]{1,64}\/f[0-9]+(?:_[0-9]+)?)$/.test(ref ?? "")) {
    return fail(command, "FAILURE_REF_REQUIRED", "failure lookup needs a retained compiler or example ref");
  }
  const index = values.get("--index") === undefined ? null : parseInteger(values.get("--index"), 0);
  const after = values.get("--after") === undefined ? null : parseInteger(values.get("--after"), 0);
  const limit = values.get("--limit") === undefined ? null : parseInteger(values.get("--limit"), 1);
  if ((selected === "diagnostic.detail" && index === null) ||
      (values.has("--after") && after === null) || (values.has("--limit") && (limit === null || limit > 25))) {
    return fail(command, "INVALID_ARGUMENTS", "diagnostic index/cursor/limit is invalid");
  }
  const checkoutRoot = values.get("--root") ?? deps.cwd;
  const lookup: SessionSocketLookup = {
    checkoutRoot,
    ...(values.has("--session") ? { sessionId: values.get("--session")! } : {}),
    ...(values.has("--app") ? { app: values.get("--app")! } : {}),
    ...(values.has("--profile") ? { profile: values.get("--profile")! } : {}),
  };
  try {
    if (selected === "start") {
      const manifest = values.get("--capture");
      const source = values.get("--source");
      if ((manifest === undefined) === (source === undefined)) {
        return fail(command, "INVALID_ARGUMENTS", "start needs exactly one of --source or --capture");
      }
      if (manifest !== undefined && ["--root", "--compiler", "--catalog", "--help-index"].some(flag => values.has(flag as Flag))) {
        return fail(command, "INVALID_ARGUMENTS", "a capture manifest already fixes root and tool inputs");
      }
      let capture: SingleFileCaptureRequest;
      if (manifest !== undefined) {
        capture = await readCaptureManifest(resolve(deps.cwd, manifest));
      } else {
        const root = resolve(deps.cwd, values.get("--root") ?? ".");
        try {
          capture = prepareLocalPreviewCapture({
            checkoutRoot: root,
            appPath: resolve(root, source!),
            compilerPath: resolve(root, values.get("--compiler") ?? process.env.CAN_DEV_COMPILER ?? "compiler/target/debug/can"),
            catalogPath: resolve(root, values.get("--catalog") ?? process.env.CAN_CATALOG ?? "packages/values/dist/catalog.json"),
            helpIndexPath: resolve(root, values.get("--help-index") ?? "docs/specification/CONSTRUCT-HELP.md"),
          });
        } catch (error) {
          throw new SessionSocketError("CAPTURE_INCOMPLETE", error instanceof Error ? error.message : "installed preview inputs are unavailable");
        }
      }
      const app = values.get("--app") ?? await declaredAppName(resolve(capture.checkoutRoot, capture.appPath));
      const started = await startDevDaemon({ selectedApp: app, capture });
      return { ok: true, command: selected, session: started.identity.sessionId,
        result: { schema: "can.dev.start.v1", attached: started.attached, root: started.identity.root, status: started.status } };
    }
    if (selected === "discover") {
      const found = await discoverDevDaemon(lookup);
      return { ok: true, command: selected, session: found.identity.sessionId,
        result: { schema: "can.dev.discover.v1", root: found.identity.root, status: found.status } };
    }
    if (selected === "stop") {
      const stopped = await stopDevDaemon(lookup);
      return { ok: true, command: selected, session: stopped.session, result: { schema: "can.dev.stop.v1", stopped: true } };
    }
    const owner = await (deps.discover ?? discoverSessionSocket)(lookup);
    const payload = selected === "example.run"
      ? { expectedRevision, ...(operation === undefined ? {} : { operation, rowIndex }) }
      : selected === "check" && expectedRevision !== undefined
      ? { expectedRevision }
      : selected === "diagnostics" || selected === "failures" ? { revision, ...(after === null ? {} : { after }), ...(limit === null ? {} : { limit }) }
      : selected === "diagnostic.detail" ? { revision, index }
      : selected === "construct.help" ? { revision, id: constructId }
      : selected === "failure.lookup" || selected === "failure.detail" || selected === "example.rerun" ? { ref }
      : undefined;
    const result = await owner.request({ command: selected, ...(payload === undefined ? {} : { payload }) });
    return { ok: true, command: selected, session: owner.identity.sessionId, result };
  } catch (error) {
    return fail(command, error instanceof SessionSocketError ? error.code : "CONTROL_UNAVAILABLE",
      error instanceof Error ? error.message : "control request failed");
  }
}
