/**
 * `can-platform gen`: BGI-03 generation dispatcher join for the Node
 * tooling host.
 *
 * Contract: `can-platform gen --request FILE` reads one v1 JSON
 * request from FILE; bare `can-platform gen` reads it from stdin.
 * Stdout carries exactly one final JSON envelope (version,
 * request_id, operation, ok, state, payload, structured errors,
 * bounded next actions); exit codes are 0/2/3/4/5/6 per BGEN14.
 * Optional JSONL progress would go to stderr; synchronous BGI-03
 * admission emits none.
 *
 * BGI-03 scope: full request validation plus the `doctor` provider
 * check (adapter availability, effective recipe with origins,
 * pre-launch preflight, launch verdict). Every other operation
 * passes admission and then fails closed with a typed
 * `not-implemented` envelope naming its joining task: saved-intake
 * operations (`status`, `inspect`, `bind`) are served by `can gen`
 * (the Rust dispatcher) in BGI-03, while execution, lifecycle, and
 * lease handlers join the host through BGI-04, BGI-05, BGI-11, and
 * BGI-12. The shared contract modules (`generation/config.ts`,
 * `generation/protocol.ts`) are the BGI-03 deliverable those
 * handlers build on.
 */

import { readFile } from "node:fs/promises";
import { access, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  ConfigError,
  loadSettings,
  resolveRecipe,
  type LoadedSettings,
  type RunOverrides,
} from "../generation/config.js";
import {
  ADAPTERS,
  EXIT_INVALID,
  EXIT_OK,
  PreflightError,
  ProtocolError,
  adapterCapabilities,
  errorEnvelope,
  okEnvelope,
  parseRequest,
  preflightRecipe,
  type DoctorParams,
  type RequestHeader,
  type ValidatedRequest,
} from "../generation/protocol.js";

/** Stdin cap: requests are small JSON; anything larger is not one. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

function writeEnvelope(envelope: string): void {
  process.stdout.write(envelope);
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new ProtocolError(
        EXIT_INVALID,
        "request-unreadable",
        `request on stdin exceeds ${MAX_REQUEST_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Unix PATH search mirroring the Rust dispatcher probe. */
async function findOnPath(name: string): Promise<string | null> {
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        access(candidate, constants.X_OK, (error) => {
          if (error === null) resolvePromise();
          else rejectPromise(error);
        });
      });
      return candidate;
    } catch {
      // Keep probing the remaining entries.
    }
  }
  return null;
}

/** Best-effort request id/operation echo for failed parses. */
function echoHeader(text: string): { request_id: string; operation: string } {
  try {
    const value: unknown = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const map = value as Record<string, unknown>;
      const request_id = typeof map["request_id"] === "string" ? map["request_id"] : "";
      const operation = typeof map["operation"] === "string" ? map["operation"] : "unknown";
      return { request_id, operation };
    }
  } catch {
    // Fall through to the markers below.
  }
  return { request_id: "", operation: "unknown" };
}

function notImplemented(header: RequestHeader, join: string): { code: number; envelope: string } {
  return {
    code: EXIT_INVALID,
    envelope: errorEnvelope(
      header.request_id,
      header.operation,
      "not-implemented",
      `operation '${header.operation}' passed admission, but its handler joins through ${join}; nothing launched and nothing changed`,
      [`resend after ${join} lands`],
    ),
  };
}

/** Host join map for operations the BGI-03 host does not handle yet. */
function hostJoinFor(operation: string): string {
  switch (operation) {
    case "status":
    case "inspect":
    case "bind":
      return "`can gen` (the Rust dispatcher serves saved-intake operations in BGI-03)";
    case "generate":
    case "refine":
    case "retry":
    case "resume":
      return "BGI-05 (capture, compatible-recipe job grouping, and execution)";
    case "diff":
    case "preview":
      return "BGI-05 (candidate inventory and machine diffs/previews)";
    case "validate":
      return "BGI-11 (interface/contract/target validators)";
    case "adopt":
    case "accept":
    case "rollback":
      return "BGI-12 (validation-to-promotion joins)";
    case "cancel":
    case "reset":
      return "BGI-05 (execution fencing) with BGI-12 (controls)";
    case "edit.begin":
    case "edit.end":
    case "lease.recover":
      return "BGI-04 (write leases)";
    default:
      return "a later BGI task";
  }
}

async function runGenDoctor(header: RequestHeader, params: DoctorParams): Promise<string> {
  const root = params.root ?? ".";
  let loaded: LoadedSettings | null;
  try {
    loaded = await loadSettings(root, params.settings);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.exitCode = EXIT_INVALID;
      return errorEnvelope(header.request_id, header.operation, error.code, error.detail, [
        "fix the settings selection and resend doctor",
      ]);
    }
    throw error;
  }
  const overrides: RunOverrides = {
    ...(params.profile === undefined ? {} : { profile: params.profile }),
    ...(params.runner === undefined ? {} : { runner: params.runner }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.max_attempts === undefined ? {} : { max_attempts: params.max_attempts }),
    ...(params.timeout_seconds === undefined ? {} : { timeout_seconds: params.timeout_seconds }),
    ...(params.native === undefined ? {} : { native: params.native }),
  };
  let recipe: ReturnType<typeof resolveRecipe> | null = null;
  let recipeError: { code: string; message: string } | null = null;
  try {
    recipe = resolveRecipe(loaded, "given", null, overrides);
  } catch (error) {
    if (error instanceof ConfigError) {
      recipeError = { code: error.code, message: `[${error.code}] ${error.detail}` };
    } else {
      throw error;
    }
  }
  const adapters: unknown[] = [];
  for (const adapter of ADAPTERS) {
    let found: { binary: string; path: string } | null = null;
    for (const binary of adapter.probe_binaries) {
      const path = await findOnPath(binary);
      if (path !== null) {
        found = { binary, path };
        break;
      }
    }
    adapters.push({
      id: adapter.id,
      label: adapter.label,
      capabilities: {
        mcp_attachment: adapter.mcp_attachment,
        write_restriction: adapter.write_restriction,
        session_resume: adapter.session_resume,
        native_options: adapter.native_options,
      },
      availability:
        found === null
          ? { found: false, binary: null, path: null, tried: [...adapter.probe_binaries] }
          : { found: true, binary: found.binary, path: found.path, tried: [...adapter.probe_binaries] },
    });
  }
  const blockers: string[] = [];
  let preflight: { ok: boolean; failures: string[] } | null = null;
  if (recipe !== null) {
    const failures: string[] = [];
    try {
      preflightRecipe(recipe);
    } catch (error) {
      if (error instanceof PreflightError) {
        failures.push(`[${error.code}] ${error.detail}`);
      } else {
        throw error;
      }
    }
    preflight = { ok: failures.length === 0, failures };
    if (failures.length === 0) {
      const adapter = adapterCapabilities(recipe.runner);
      let binaryFound = false;
      if (adapter !== undefined) {
        for (const binary of adapter.probe_binaries) {
          if ((await findOnPath(binary)) !== null) {
            binaryFound = true;
            break;
          }
        }
      }
      if (!binaryFound) {
        blockers.push(
          `runner \`${recipe.runner}\` has no executable on PATH (tried: ${adapter?.probe_binaries.join(", ") ?? ""})`,
        );
      }
    } else {
      blockers.push(...failures);
    }
  } else if (recipeError !== null) {
    blockers.push(recipeError.message);
  }
  const recipeSelected =
    params.settings !== undefined ||
    params.profile !== undefined ||
    params.runner !== undefined ||
    params.model !== undefined ||
    (loaded !== null &&
      (loaded.settings.shared.runner !== null || Object.keys(loaded.settings.profiles).length > 0));
  if (!recipeSelected) {
    blockers.length = 0;
    blockers.push(
      "no recipe selected: pass settings, a profile, or runner/model overrides to check one recipe",
    );
  }
  const verdict = blockers.length === 0 ? "ready" : "blocked";
  const next =
    verdict === "blocked"
      ? ["resolve the reported blockers, then resend doctor"]
      : ["the selected recipe can launch; send an execution request"];
  process.exitCode = EXIT_OK;
  return okEnvelope(
    header,
    "reported",
    {
      adapters,
      recipe,
      recipe_error: recipeError,
      preflight,
      verdict,
      blockers,
      auth: "native CLI login is not probed by BGI-03; BGI-05 qualifies per-adapter authentication",
    },
    next,
  );
}

/**
 * Run one `gen` request: read via `--request FILE` or stdin, validate
 * against the v1 protocol, serve `doctor`, and fail closed with typed
 * `not-implemented` envelopes for every other admitted operation.
 */
export async function runGen(genRequest: string | null): Promise<void> {
  let text: string;
  if (genRequest !== null) {
    try {
      text = await readFile(genRequest, "utf8");
    } catch (error) {
      process.exitCode = EXIT_INVALID;
      writeEnvelope(
        errorEnvelope(
          "",
          "unknown",
          "request-unreadable",
          `cannot read request '${genRequest}': ${error instanceof Error ? error.message : String(error)}`,
          ["pass a readable --request FILE or pipe the request on stdin"],
        ),
      );
      return;
    }
  } else {
    try {
      text = await readStdinText();
    } catch (error) {
      const echo = echoHeader("");
      process.exitCode = EXIT_INVALID;
      writeEnvelope(
        errorEnvelope(
          echo.request_id,
          echo.operation,
          "request-unreadable",
          error instanceof Error ? error.message : String(error),
          ["pipe one v1 JSON request on stdin or use --request FILE"],
        ),
      );
      return;
    }
  }
  let validated: ValidatedRequest;
  try {
    validated = parseRequest(text);
  } catch (error) {
    if (error instanceof ProtocolError) {
      const echo = echoHeader(text);
      process.exitCode = error.exit;
      writeEnvelope(
        errorEnvelope(echo.request_id, echo.operation, error.code, error.detail, [
          "fix the request and resend (see can help gen)",
        ]),
      );
      return;
    }
    throw error;
  }
  if (validated.params.kind === "doctor") {
    writeEnvelope(await runGenDoctor(validated.header, validated.params.params));
    return;
  }
  const { code, envelope } = notImplemented(validated.header, hostJoinFor(validated.header.operation));
  process.exitCode = code;
  writeEnvelope(envelope);
}
