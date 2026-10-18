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
 * pre-launch preflight, launch verdict). BGI-12 routes every other
 * admitted operation to the control layer
 * (`generation/controls.ts`), which composes the accepted producer
 * mechanisms: compiler inspection/validation through the `can`
 * binary, BGI-05 execution/lifecycle, BGI-04 journals/leases, and
 * BGI-11 validation-to-promotion joins. The shared contract modules
 * (`generation/config.ts`, `generation/protocol.ts`) stay the
 * deliverable those handlers build on.
 */

import { readFile } from "node:fs/promises";
import {
  ConfigError,
  loadSettings,
  resolveRecipe,
  type LoadedSettings,
  type RunOverrides,
} from "../generation/config.js";
import { dispatchControl } from "../generation/controls.js";
import { adapterFor, probeExecutable } from "../generation/adapters.js";
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
  progressEvent,
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

/** Match the runner launch resolver, including explicit host executable selection. */
async function findOnPath(name: string): Promise<string | null> {
  return probeExecutable([name]).catch(() => null);
}

function selectedBinaries(id: string): { binaries: readonly string[]; error: string | null } {
  try { return { binaries: adapterFor(id).probeBinaries(), error: null }; }
  catch (error) { return { binaries: [], error: error instanceof Error ? error.message : String(error) }; }
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



async function describeAdapter(adapter: (typeof ADAPTERS)[number]): Promise<unknown> {
  const selection = selectedBinaries(adapter.id);
  const binaries = selection.binaries;
  let found: { binary: string; path: string } | null = null;
  for (const binary of binaries) {
    const path = await findOnPath(binary);
    if (path !== null) {
      found = { binary, path };
      break;
    }
  }
  return {
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
        ? { found: false, binary: null, path: null, tried: [...binaries], ...(selection.error === null ? {} : { error: selection.error }) }
        : { found: true, binary: found.binary, path: found.path, tried: [...binaries] },
  };
}

async function checkRecipeBinary(recipe: { runner: string }): Promise<string[]> {
  const adapter = adapterCapabilities(recipe.runner);
  const selection = selectedBinaries(recipe.runner);
  const binaries = selection.binaries;
  let binaryFound = false;
  if (adapter !== undefined) {
    for (const binary of binaries) {
      if ((await findOnPath(binary)) !== null) {
        binaryFound = true;
        break;
      }
    }
  }
  const blockers: string[] = [];
  if (selection.error !== null) blockers.push(selection.error);
  if (!binaryFound) {
    blockers.push(`runner \`${recipe.runner}\` has no executable for the selected host path (tried: ${binaries.join(", ")})`);
  }
  return blockers;
}

function resolveDoctorRecipe(loaded: LoadedSettings | null, overrides: RunOverrides): {
  recipe: ReturnType<typeof resolveRecipe> | null; recipeError: { code: string; message: string } | null;
} {
  try {
    return { recipe: resolveRecipe(loaded, "given", null, overrides), recipeError: null };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { recipe: null, recipeError: { code: error.code, message: `[${error.code}] ${error.detail}` } };
    }
    throw error;
  }
}

async function collectRecipeBlockers(recipe: ReturnType<typeof resolveRecipe> | null,
  recipeError: { code: string; message: string } | null): Promise<{ preflight: { ok: boolean; failures: string[] } | null; blockers: string[] }> {
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
      blockers.push(...await checkRecipeBinary(recipe));
    } else {
      blockers.push(...failures);
    }
  } else if (recipeError !== null) {
    blockers.push(recipeError.message);
  }
  return { preflight, blockers };
}

function checkRecipeSelected(params: DoctorParams, loaded: LoadedSettings | null, blockers: string[]): void {
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
  const { recipe, recipeError } = resolveDoctorRecipe(loaded, overrides);
  const adapters: unknown[] = [];
  for (const adapter of ADAPTERS) {
    adapters.push(await describeAdapter(adapter));
  }
  const { preflight, blockers } = await collectRecipeBlockers(recipe, recipeError);
  checkRecipeSelected(params, loaded, blockers);
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
 * against the v1 protocol, serve `doctor` here, and route every other
 * admitted operation to the BGI-12 control layer. Refine requests
 * selecting the stdin instruction carrier beside `--request FILE`
 * read the instruction from stdin here; the control layer owns the
 * exclusive-carrier refusal when the request itself rode stdin.
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
  let stdinText: string | undefined;
  if (
    validated.params.kind === "refine" &&
    validated.params.params.instruction_stdin === true &&
    genRequest !== null
  ) {
    try {
      stdinText = await readStdinText();
    } catch (error) {
      process.exitCode = EXIT_INVALID;
      writeEnvelope(
        errorEnvelope(
          validated.header.request_id,
          validated.header.operation,
          "request-unreadable",
          error instanceof Error ? error.message : String(error),
          ["pipe a non-empty instruction on stdin and resend"],
        ),
      );
      return;
    }
  }
  const { code, envelope } = await dispatchControl(text, {
    ...(stdinText === undefined ? {} : { stdinText }),
    onEvent: (phase, detail) => {
      process.stderr.write(progressEvent(validated.header.request_id, validated.header.operation, phase, detail));
    },
  });
  process.exitCode = code;
  writeEnvelope(envelope);
}
