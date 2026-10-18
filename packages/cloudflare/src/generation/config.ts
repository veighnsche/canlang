/**
 * Generation configuration (BGI-03): `can.gen.toml` v1 settings,
 * effective-recipe resolution, and per-field origins.
 *
 * This mirrors the Rust `analysis::generation_config` shapes exactly:
 * strict v1 TOML parsing (via the maintained `smol-toml` package,
 * never a hand-rolled parser), explicit settings-file selection with
 * no ambient search, complete runner/model profile pairs, shared
 * finite-limit reuse without an inheritance graph, Given/frontend
 * role defaults (ordinary When has no generator recipe), explicit
 * run-override precedence, and per-field origin reporting. Both
 * hosts must accept the same files and resolve the same recipes.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** Generation protocol major version (requests, results, settings). */
export const GEN_PROTOCOL_VERSION = 1;
/** Settings filename at the explicitly supplied project root. */
export const SETTINGS_FILE = "can.gen.toml";
/** Reserved Then profile name: used when configured, else shared. */
export const FRONTEND_PROFILE = "frontend";
/** Built-in default: one bounded runner execution per request. */
export const DEFAULT_MAX_ATTEMPTS = 1;
/** Built-in default: 600 seconds per requested execution. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/** Supported runner adapter ids (frozen v1 set). */
export const RUNNERS = ["codex", "muse", "claude-code", "opencode"] as const;
/** One supported runner adapter id. */
export type RunnerId = (typeof RUNNERS)[number];

/** Typed configuration failure (the dispatcher maps these to exit 2). */
export class ConfigError extends Error {
  /** Machine-readable code (`unknown-profile`, ...). */
  readonly code: string;
  /** Human-actionable detail without the code prefix. */
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "ConfigError";
    this.code = code;
    this.detail = detail;
  }
}

/** Scalar JSON admitted in native option maps. */
export type NativeScalar = string | number | boolean;
/** Flat scalar native options for one recipe and adapter. */
export type NativeMap = Record<string, NativeScalar>;

/**
 * Shared `[generation]` recipe. Runner/model are optional at parse:
 * a settings file may exist before generation is configured, and the
 * missing pair fails only when an execution resolves it. Ordinary
 * saved builds never consult this shape.
 */
export interface SharedRecipe {
  /** Selected CLI adapter id (known runner when present). */
  runner: string | null;
  /** Explicit model id for that runner. */
  model: string | null;
  /** Finite attempt bound (built-in default 1 when omitted). */
  max_attempts: number | null;
  /** Finite per-execution timeout (built-in default 600 when omitted). */
  timeout_seconds: number | null;
  /** Flat scalar native options for the shared runner. */
  native: NativeMap;
}

/**
 * One complete `[generation.profiles.<name>]` runner/model pair.
 * Profiles are complete at parse: a profile missing either field is
 * a config error, never a partial inheritance row.
 */
export interface ProfileRecipe {
  /** Selected CLI adapter id. */
  runner: string;
  /** Explicit model id for that runner. */
  model: string;
  /** Optional override; omitted limits reuse shared limits. */
  max_attempts: number | null;
  /** Optional override; omitted limits reuse shared limits. */
  timeout_seconds: number | null;
  /**
   * Flat scalar native options for this profile's runner only.
   * Shared native options are never inherited into a profile.
   */
  native: NativeMap;
}

/** Parsed `can.gen.toml` v1: shared recipe plus complete named profiles. */
export interface GenerationSettings {
  /** Shared `[generation]` recipe (Given default; Then fallback). */
  shared: SharedRecipe;
  /** Complete named `[generation.profiles.<name>]` pairs. */
  profiles: Record<string, ProfileRecipe>;
}

/**
 * Which settings file was selected (an explicit file replaces the
 * root file; there is no ambient search).
 */
export type SettingsSource =
  | { readonly kind: "root"; readonly path: string }
  | { readonly kind: "explicit"; readonly path: string };

/** Parsed settings with their selected source file. */
export interface LoadedSettings {
  /** Which file supplied these settings. */
  source: SettingsSource;
  /** Parsed v1 settings. */
  settings: GenerationSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectExtra(table: Record<string, unknown>, where: string, known: readonly string[]): void {
  const extra = Object.keys(table)[0];
  if (extra !== undefined) {
    throw new ConfigError(
      "invalid-settings",
      `unknown settings key \`${extra}\` in ${where}; known keys: ${known.join(", ")}`,
    );
  }
}

function takeString(
  table: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  if (!(key in table)) return null;
  const value = table[key];
  delete table[key];
  if (typeof value !== "string") {
    throw new ConfigError("invalid-settings", `settings \`${key}\` in ${where} must be a string`);
  }
  return value;
}

function takeLimit(table: Record<string, unknown>, key: string, where: string): number | null {
  if (!(key in table)) return null;
  const value = table[key];
  delete table[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0xffffffff
  ) {
    throw new ConfigError(
      "invalid-settings",
      `settings \`${key}\` in ${where} must be a positive finite integer`,
    );
  }
  return value;
}

function takeNative(table: Record<string, unknown>, where: string): NativeMap {
  if (!("native" in table)) return {};
  const value = table["native"];
  delete table["native"];
  if (!isRecord(value)) {
    throw new ConfigError(
      "invalid-settings",
      `settings \`native\` in ${where} must be a flat table of scalars`,
    );
  }
  const native: NativeMap = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new ConfigError(
        "invalid-settings",
        `settings native option \`${key}\` in ${where} must be a scalar string, integer, float or boolean`,
      );
    }
    native[key] = entry;
  }
  return native;
}

function checkRunner(runner: string, where: string): void {
  if (!(RUNNERS as readonly string[]).includes(runner)) {
    throw new ConfigError(
      "unknown-runner",
      `unknown runner \`${runner}\` in ${where}; supported runners: ${RUNNERS.join(", ")}`,
    );
  }
}

function checkModel(model: string, where: string): void {
  if (model.trim().length === 0) {
    throw new ConfigError(
      "invalid-settings",
      `settings \`model\` in ${where} must be a non-empty model id`,
    );
  }
}

function parseSharedRecipe(table: Record<string, unknown>): SharedRecipe {
  const runner = takeString(table, "runner", "[generation]");
  if (runner !== null) checkRunner(runner, "[generation]");
  const model = takeString(table, "model", "[generation]");
  if (model !== null) checkModel(model, "[generation]");
  const max_attempts = takeLimit(table, "max_attempts", "[generation]");
  const timeout_seconds = takeLimit(table, "timeout_seconds", "[generation]");
  const native = takeNative(table, "[generation]");
  return { runner, model, max_attempts, timeout_seconds, native };
}

function parseProfiles(generation: Record<string, unknown>): Record<string, ProfileRecipe> {
  if (!("profiles" in generation)) return {};
  const value = generation["profiles"];
  delete generation["profiles"];
  if (!isRecord(value)) {
    throw new ConfigError(
      "invalid-settings",
      "[generation.profiles] must be a table of complete runner/model pairs",
    );
  }
  const parsed: Record<string, ProfileRecipe> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (name.length === 0) {
      throw new ConfigError("invalid-settings", "profile names must be non-empty");
    }
    const where = `[generation.profiles.${name}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(
        "invalid-settings",
        `${where} must be a table with a complete runner/model pair`,
      );
    }
    const profile: Record<string, unknown> = { ...entry };
    const runner = takeString(profile, "runner", where);
    if (runner === null) {
      throw new ConfigError(
        "invalid-settings",
        `${where} misses \`runner\`; profile pairs are complete`,
      );
    }
    checkRunner(runner, where);
    const model = takeString(profile, "model", where);
    if (model === null) {
      throw new ConfigError(
        "invalid-settings",
        `${where} misses \`model\`; profile pairs are complete`,
      );
    }
    checkModel(model, where);
    const max_attempts = takeLimit(profile, "max_attempts", where);
    const timeout_seconds = takeLimit(profile, "timeout_seconds", where);
    const native = takeNative(profile, where);
    rejectExtra(profile, where, ["runner", "model", "max_attempts", "timeout_seconds", "native"]);
    parsed[name] = { runner, model, max_attempts, timeout_seconds, native };
  }
  return parsed;
}

/**
 * Parse `can.gen.toml` v1 text strictly: unknown tables/keys fail,
 * `version` must be 1, `[generation]` must exist, runners must be
 * known, models must be non-empty, profiles must be complete pairs,
 * and limits must be positive finite integers.
 */
export function parseSettingsToml(text: string): GenerationSettings {
  let root: unknown;
  try {
    root = parseToml(text);
  } catch (error) {
    throw new ConfigError(
      "invalid-settings",
      `settings TOML does not parse: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
  if (!isRecord(root)) {
    throw new ConfigError("invalid-settings", "settings TOML must be a table");
  }
  const table: Record<string, unknown> = { ...root };
  if (!("version" in table)) {
    throw new ConfigError(
      "invalid-settings",
      "settings miss `version = 1`; the v1 schema requires it",
    );
  }
  const version = table["version"];
  delete table["version"];
  if (version !== GEN_PROTOCOL_VERSION) {
    throw new ConfigError(
      "invalid-settings",
      version === 1
        ? "settings `version` must be the integer 1"
        : `unsupported settings \`version = ${String(version)}\`; this dispatcher implements v1`,
    );
  }
  if (!("generation" in table)) {
    throw new ConfigError(
      "invalid-settings",
      "settings miss the `[generation]` table; the v1 schema requires it",
    );
  }
  const generation = table["generation"];
  delete table["generation"];
  if (!isRecord(generation)) {
    throw new ConfigError("invalid-settings", "[generation] must be a table");
  }
  const mutable: Record<string, unknown> = { ...generation };
  const shared = parseSharedRecipe(mutable);
  const profiles = parseProfiles(mutable);
  rejectExtra(mutable, "[generation]", [
    "runner",
    "model",
    "max_attempts",
    "timeout_seconds",
    "native",
    "profiles",
  ]);
  rejectExtra(table, "settings root", ["version", "generation"]);
  return { shared, profiles };
}

/**
 * Resolve a request-relative path against the project root. Absolute
 * paths pass through; relative paths never consult the process
 * working directory, so machine-generated requests resolve
 * deterministically from their explicit root.
 */
export function resolveAgainstRoot(root: string, path: string): string {
  if (isAbsolute(path)) return path;
  return join(root, path);
}

/**
 * Select and load settings: an explicit file replaces
 * `<root>/can.gen.toml`; without one, the root file loads when
 * present. No ambient user/local/ancestor search ever runs: a
 * missing root file means unconfigured (`null`), never an error.
 */
export async function loadSettings(
  root: string,
  explicit?: string,
): Promise<LoadedSettings | null> {
  if (explicit !== undefined) {
    if (explicit.length === 0) {
      throw new ConfigError("invalid-settings", "an explicit settings file must be a non-empty path");
    }
    const path = resolveAgainstRoot(root, explicit);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw new ConfigError(
        "settings-not-found",
        `cannot read settings '${path}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return { source: { kind: "explicit", path }, settings: parseSettingsToml(text) };
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new ConfigError(error.code, `${path}: ${error.detail}`);
      }
      throw error;
    }
  }
  const path = join(root, SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new ConfigError(
      "settings-not-found",
      `cannot read settings '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return { source: { kind: "root", path }, settings: parseSettingsToml(text) };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(error.code, `${path}: ${error.detail}`);
    }
    throw error;
  }
}

/**
 * Generation category selecting the recipe default. Given uses the
 * shared recipe; Then uses the reserved `frontend` profile when
 * configured, else shared. Ordinary When has no generator recipe:
 * there is deliberately no third value here.
 */
export type RecipeCategory = "given" | "frontend";

/**
 * Explicit per-run overrides. A runner override requires an explicit
 * compatible model (same request); models never cross runners
 * implicitly, and native maps replace wholesale (no merge).
 */
export interface RunOverrides {
  /** Explicit run profile selecting a complete pair. */
  profile?: string;
  /** Explicit runner, requiring an explicit model in the same run. */
  runner?: string;
  /** Explicit model for the effective runner. */
  model?: string;
  /** Explicit finite attempt bound. */
  max_attempts?: number;
  /** Explicit finite per-execution timeout. */
  timeout_seconds?: number;
  /** Explicit native map replacing the recipe's table wholesale. */
  native?: NativeMap;
}

/** One resolved runner/model recipe with per-field origins. */
export interface EffectiveRecipe {
  /** Resolved adapter id. */
  runner: string;
  /** Resolved model id for that adapter. */
  model: string;
  /** Resolved finite attempt bound. */
  max_attempts: number;
  /** Resolved finite per-execution timeout. */
  timeout_seconds: number;
  /** Resolved native map for the effective runner. */
  native: NativeMap;
  /** Origin per field (`runner`, `model`, `max_attempts`, `timeout_seconds`, `native`). */
  origins: Record<string, string>;
  /** Selected settings file, when any settings were consulted. */
  settings: string | null;
  /** Which recipe row won: profile name, shared, or run overrides. */
  recipe_source: string;
}

interface BaseRow {
  runner: string | null;
  model: string | null;
  max_attempts: number | null;
  timeout_seconds: number | null;
  native: NativeMap;
  label: string;
}

function checkNativeScalars(native: NativeMap): void {
  for (const [key, value] of Object.entries(native)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new ConfigError(
        "invalid-settings",
        `run override native option \`${key}\` must be a scalar string, number or boolean`,
      );
    }
  }
}

/**
 * Resolve the effective recipe: explicit run profile, else the
 * owning declaration's `agent`, else the category default
 * (frontend profile for Then, shared otherwise); explicit run
 * values override the selected recipe field by field. Every
 * effective value reports its origin.
 *
 * `loaded` is `null` when no settings file was selected: then only
 * a fully explicit run recipe (runner plus model) resolves, with
 * built-in finite limits.
 */
function checkRunOverrides(overrides: RunOverrides): void {
  if (overrides.runner !== undefined) {
    checkRunner(overrides.runner, "run overrides");
  }
  if (overrides.model !== undefined && overrides.model.trim().length === 0) {
    throw new ConfigError("invalid-settings", "run override `model` must be a non-empty model id");
  }
  if (overrides.native !== undefined) {
    checkNativeScalars(overrides.native);
  }
  // Per-run limits share the TOML positive-finite domain: zero is
  // outside it and refuses here, before any recipe construction or
  // runner launch. Explicit finite positive overrides still win.
  for (const key of ["max_attempts", "timeout_seconds"] as const) {
    if (overrides[key] === 0) {
      throw new ConfigError(
        "invalid-settings",
        `run override \`${key}\` must be a positive finite integer`,
      );
    }
  }
}

function selectBaseName(
  loaded: LoadedSettings | null,
  category: RecipeCategory,
  declarationAgent: string | null,
  overrides: RunOverrides,
): string | null {
  // Base recipe row: explicit run profile, else declaration agent,
  // else the category default (the frontend profile only when
  // settings exist to supply it, else shared).
  if (overrides.profile !== undefined) return overrides.profile;
  if (declarationAgent !== null) return declarationAgent;
  if (loaded !== null && category === "frontend") return FRONTEND_PROFILE;
  return null;
}

function baseFromProfile(
  loaded: LoadedSettings,
  baseName: string,
  declarationAgent: string | null,
  overrides: RunOverrides,
  settingsPath: string | null,
): BaseRow {
  const suffix = settingsPath === null ? "" : ` (${settingsPath})`;
  const profile = loaded.settings.profiles[baseName];
  if (profile !== undefined) {
    return {
      runner: profile.runner,
      model: profile.model,
      max_attempts: profile.max_attempts ?? loaded.settings.shared.max_attempts,
      timeout_seconds: profile.timeout_seconds ?? loaded.settings.shared.timeout_seconds,
      native: { ...profile.native },
      label: `profile '${baseName}'${suffix}`,
    };
  }
  // Only the implicit Then category default falls back to shared
  // when no `frontend` profile is configured; an explicit
  // declaration `agent=frontend` (or run profile) names a profile
  // that must exist, so it diagnoses like any unknown profile.
  if (baseName === FRONTEND_PROFILE && overrides.profile === undefined && declarationAgent === null) {
    const shared = loaded.settings.shared;
    return {
      runner: shared.runner,
      model: shared.model,
      max_attempts: shared.max_attempts,
      timeout_seconds: shared.timeout_seconds,
      native: { ...shared.native },
      label: `shared recipe${suffix}`,
    };
  }
  const known = Object.keys(loaded.settings.profiles);
  const hint =
    known.length === 0 ? "the settings define no profiles" : `known profiles: ${known.join(", ")}`;
  throw new ConfigError(
    "unknown-profile",
    `unknown profile '${baseName}'${suffix}; ${hint}`,
  );
}

function sharedBaseRow(loaded: LoadedSettings, settingsPath: string | null): BaseRow {
  const shared = loaded.settings.shared;
  const suffix = settingsPath === null ? "" : ` (${settingsPath})`;
  return {
    runner: shared.runner,
    model: shared.model,
    max_attempts: shared.max_attempts,
    timeout_seconds: shared.timeout_seconds,
    native: { ...shared.native },
    label: `shared recipe${suffix}`,
  };
}

function resolveBaseRow(
  loaded: LoadedSettings | null,
  baseName: string | null,
  declarationAgent: string | null,
  overrides: RunOverrides,
  settingsPath: string | null,
): BaseRow {
  if (loaded !== null && baseName !== null) {
    return baseFromProfile(loaded, baseName, declarationAgent, overrides, settingsPath);
  }
  if (loaded !== null) return sharedBaseRow(loaded, settingsPath);
  if (baseName !== null) {
    throw new ConfigError(
      "unknown-profile",
      `unknown profile '${baseName}': no settings file supplies profiles (explicit run overrides still need no settings)`,
    );
  }
  return {
    runner: null,
    model: null,
    max_attempts: null,
    timeout_seconds: null,
    native: {},
    label: "run overrides",
  };
}

export function resolveRecipe(
  loaded: LoadedSettings | null,
  category: RecipeCategory,
  declarationAgent: string | null,
  overrides: RunOverrides,
): EffectiveRecipe {
  checkRunOverrides(overrides);
  const baseName = selectBaseName(loaded, category, declarationAgent, overrides);
  const settingsPath = loaded?.source.path ?? null;
  const base = resolveBaseRow(loaded, baseName, declarationAgent, overrides, settingsPath);
  // Runner/model: overrides win, but a runner override requires an
  // explicit model in the same run (no cross-runner inheritance).
  if (overrides.runner !== undefined && overrides.model === undefined) {
    throw new ConfigError(
      "runner-override-needs-model",
      "a run runner override requires an explicit compatible model in the same run; models never carry across runners",
    );
  }
  const origins: Record<string, string> = {};
  const { runner, model } = resolveRunnerModel(overrides, base, origins);
  const { max_attempts, timeout_seconds } = resolveRecipeLimits(overrides, base, loaded, origins);
  // Native maps replace wholesale: an explicit run map wins, else
  // the selected recipe's own table (profiles never inherit shared
  // native controls across runners).
  let native: NativeMap;
  if (overrides.native !== undefined) {
    native = { ...overrides.native };
    origins["native"] = "run override";
  } else {
    native = { ...base.native };
    origins["native"] = base.label;
  }
  return {
    runner,
    model,
    max_attempts,
    timeout_seconds,
    native,
    origins,
    settings: settingsPath,
    recipe_source: base.label,
  };
}

function resolveRunnerModel(
  overrides: RunOverrides,
  base: BaseRow,
  origins: Record<string, string>,
): { runner: string; model: string } {
  let runner: string;
  if (overrides.runner !== undefined) {
    origins["runner"] = "run override";
    runner = overrides.runner;
  } else if (base.runner !== null) {
    origins["runner"] = base.label;
    runner = base.runner;
  } else {
    throw new ConfigError(
      "missing-recipe",
      "no runner resolves: configure shared `runner`/`model`, select a profile, or pass explicit run overrides",
    );
  }
  let model: string;
  if (overrides.model !== undefined) {
    origins["model"] = "run override";
    model = overrides.model;
  } else if (base.model !== null) {
    origins["model"] = base.label;
    model = base.model;
  } else {
    throw new ConfigError(
      "missing-recipe",
      "no model resolves: configure shared `runner`/`model`, select a profile, or pass explicit run overrides",
    );
  }
  return { runner, model };
}

function resolveRecipeLimits(
  overrides: RunOverrides,
  base: BaseRow,
  loaded: LoadedSettings | null,
  origins: Record<string, string>,
): { max_attempts: number; timeout_seconds: number } {
  // A profile row reuses shared finite limits when it omits them;
  // report the shared origin so callers see the reuse.
  const limitOrigin = (key: "max_attempts" | "timeout_seconds"): string => {
    if (base.label.startsWith("profile '") && loaded !== null) {
      const name = base.label.slice("profile '".length).split("'")[0] ?? "";
      const profile = loaded.settings.profiles[name];
      if (profile !== undefined && profile[key] === null) {
        return `shared limits (${loaded.source.path})`;
      }
    }
    return base.label;
  };
  let max_attempts: number;
  if (overrides.max_attempts !== undefined) {
    max_attempts = overrides.max_attempts;
    origins["max_attempts"] = "run override";
  } else if (base.max_attempts !== null) {
    max_attempts = base.max_attempts;
    origins["max_attempts"] = limitOrigin("max_attempts");
  } else {
    max_attempts = DEFAULT_MAX_ATTEMPTS;
    origins["max_attempts"] = "built-in default";
  }
  let timeout_seconds: number;
  if (overrides.timeout_seconds !== undefined) {
    timeout_seconds = overrides.timeout_seconds;
    origins["timeout_seconds"] = "run override";
  } else if (base.timeout_seconds !== null) {
    timeout_seconds = base.timeout_seconds;
    origins["timeout_seconds"] = limitOrigin("timeout_seconds");
  } else {
    timeout_seconds = DEFAULT_TIMEOUT_SECONDS;
    origins["timeout_seconds"] = "built-in default";
  }
  return { max_attempts, timeout_seconds };
}
