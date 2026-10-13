/**
 * BGI-03 config tests: `can.gen.toml` v1 parsing, settings
 * selection, effective-recipe resolution with origins, and role
 * defaults. Mirrors the Rust `bgi03_config` coverage so both hosts
 * accept the same files and resolve the same recipes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_SECONDS,
  RUNNERS,
  loadSettings,
  parseSettingsToml,
  resolveRecipe,
  type LoadedSettings,
} from "./config.js";

const SETTINGS = `version = 1

[generation]
runner = "codex"
model = "shared-model"
max_attempts = 2
timeout_seconds = 300

[generation.profiles.fast]
runner = "opencode"
model = "fast-model"

[generation.profiles.frontend]
runner = "muse"
model = "front-model"
timeout_seconds = 120
`;

function loaded(text: string): LoadedSettings {
  return { source: { kind: "root", path: "can.gen.toml" }, settings: parseSettingsToml(text) };
}

test("settings TOML schema is strict", () => {
  const settings = parseSettingsToml(SETTINGS);
  assert.equal(settings.shared.runner, "codex");
  assert.equal(settings.shared.model, "shared-model");
  assert.equal(settings.shared.max_attempts, 2);
  assert.equal(settings.shared.timeout_seconds, 300);
  assert.equal(Object.keys(settings.profiles).length, 2);
  assert.equal(settings.profiles["fast"]?.runner, "opencode");
  const bad = [
    'version = 1\napp = "x"\n[generation]\nrunner = "codex"\nmodel = "m"\n',
    'version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\nruner = "x"\n',
    'version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n[generation.profiles.fast]\nrunner = "opencode"\nmodel = "m"\nextra = 1\n',
    'version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n[generation.surprise]\n',
  ];
  for (const text of bad) {
    assert.throws(() => parseSettingsToml(text), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid-settings");
      assert.match(error.detail, /unknown/);
      return true;
    }, text);
  }
  assert.throws(() => parseSettingsToml('[generation]\nrunner = "codex"\nmodel = "m"\n'));
  assert.throws(() => parseSettingsToml('version = 2\n[generation]\nrunner = "codex"\nmodel = "m"\n'));
  assert.throws(() => parseSettingsToml("version = 1\n"));
  assert.throws(
    () => parseSettingsToml('version = 1\n[generation]\nrunner = "teleport"\nmodel = "m"\n'),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unknown-runner");
      return true;
    },
  );
  assert.throws(() =>
    parseSettingsToml('version = 1\n[generation]\nrunner = "codex"\nmodel = "  "\n'),
  );
  assert.throws(() =>
    parseSettingsToml(
      'version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n[generation.profiles.half]\nrunner = "opencode"\n',
    ),
  );
  for (const limit of ["0", "-3", '"many"', "1.5"]) {
    assert.throws(
      () =>
        parseSettingsToml(
          `version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\nmax_attempts = ${limit}\n`,
        ),
      `max_attempts = ${limit}`,
    );
  }
  assert.throws(() =>
    parseSettingsToml(
      'version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n[generation.native]\ndeep = {a = 1}\n',
    ),
  );
  const native = parseSettingsToml(
    'version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n[generation.native]\nflag = true\nlevel = 3\n',
  );
  assert.equal(Object.keys(native.shared.native).length, 2);
});

test("settings selection replaces without ambient search", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bgi03-config-"));
  try {
    const root = join(dir, "proj");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    // An ancestor file is never consulted: no ambient search.
    await writeFile(
      join(dir, "can.gen.toml"),
      'version = 1\n[generation]\nrunner = "muse"\nmodel = "ancestor"\n',
    );
    assert.equal(await loadSettings(root), null);
    await writeFile(join(root, "can.gen.toml"), SETTINGS);
    const fromRoot = await loadSettings(root);
    assert.ok(fromRoot !== null);
    assert.equal(fromRoot.source.kind, "root");
    assert.equal(fromRoot.settings.shared.runner, "codex");
    // An explicit file replaces the root file; relative paths resolve at root.
    await writeFile(
      join(root, "alt.toml"),
      'version = 1\n[generation]\nrunner = "opencode"\nmodel = "alt"\n',
    );
    const explicit = await loadSettings(root, "alt.toml");
    assert.ok(explicit !== null);
    assert.equal(explicit.source.kind, "explicit");
    assert.equal(explicit.settings.shared.runner, "opencode");
    await assert.rejects(loadSettings(root, "missing.toml"), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "settings-not-found");
      return true;
    });
    await writeFile(join(root, "broken.toml"), "version = 1\n[generation\n");
    await assert.rejects(loadSettings(root, "broken.toml"), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "invalid-settings");
      assert.match(error.detail, /broken\.toml/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown profiles diagnose", () => {
  const found = loaded(SETTINGS);
  assert.throws(
    () => resolveRecipe(found, "given", null, { profile: "nope" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unknown-profile");
      assert.match(error.detail, /nope/);
      assert.match(error.detail, /fast/);
      return true;
    },
  );
  assert.throws(
    () => resolveRecipe(found, "given", "ghost", {}),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unknown-profile");
      return true;
    },
  );
  assert.throws(
    () => resolveRecipe(null, "given", null, { profile: "nope" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unknown-profile");
      return true;
    },
  );
});

test("runner override requires explicit model", () => {
  const found = loaded(SETTINGS);
  assert.throws(
    () => resolveRecipe(found, "given", null, { runner: "opencode" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "runner-override-needs-model");
      return true;
    },
  );
  const resolved = resolveRecipe(found, "given", null, {
    runner: "opencode",
    model: "other-model",
  });
  assert.equal(resolved.runner, "opencode");
  assert.equal(resolved.model, "other-model");
  assert.equal(resolved.origins["runner"], "run override");
  // A model-only override keeps the base runner.
  const modelOnly = resolveRecipe(found, "given", null, { model: "new-model" });
  assert.equal(modelOnly.runner, "codex");
  assert.equal(modelOnly.model, "new-model");
  // Full overrides resolve with no settings at all.
  const bare = resolveRecipe(null, "frontend", null, { runner: "codex", model: "m" });
  assert.equal(bare.max_attempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(bare.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);
  assert.equal(bare.origins["max_attempts"], "built-in default");
  assert.throws(
    () => resolveRecipe(null, "given", null, {}),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "missing-recipe");
      return true;
    },
  );
});

test("effective values, origins, and role defaults", () => {
  const found = loaded(SETTINGS);
  // Given uses the shared recipe.
  const given = resolveRecipe(found, "given", null, {});
  assert.equal(given.runner, "codex");
  assert.equal(given.model, "shared-model");
  assert.equal(given.max_attempts, 2);
  assert.equal(given.timeout_seconds, 300);
  assert.match(given.origins["runner"] ?? "", /^shared recipe/);
  // Then uses the reserved frontend profile when configured.
  const frontend = resolveRecipe(found, "frontend", null, {});
  assert.equal(frontend.runner, "muse");
  assert.equal(frontend.model, "front-model");
  assert.equal(frontend.timeout_seconds, 120);
  // The frontend profile reuses shared max_attempts, and says so.
  assert.equal(frontend.max_attempts, 2);
  assert.match(frontend.origins["max_attempts"] ?? "", /^shared limits/);
  // Then falls back to shared when no frontend profile exists.
  const plain = loaded('version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n');
  const fallback = resolveRecipe(plain, "frontend", null, {});
  assert.equal(fallback.runner, "codex");
  // Explicit run profiles beat declaration agents and defaults.
  const pinned = resolveRecipe(found, "frontend", "frontend", { profile: "fast" });
  assert.equal(pinned.runner, "opencode");
  assert.match(pinned.origins["runner"] ?? "", /^profile 'fast'/);
  // Declaration agents beat category defaults.
  const agent = resolveRecipe(found, "frontend", "fast", {});
  assert.equal(agent.runner, "opencode");
  // Overrides beat the selected profile field by field.
  const overridden = resolveRecipe(found, "given", null, {
    profile: "fast",
    timeout_seconds: 45,
  });
  assert.equal(overridden.runner, "opencode");
  assert.equal(overridden.timeout_seconds, 45);
  assert.equal(overridden.origins["timeout_seconds"], "run override");
  assert.equal(overridden.max_attempts, 2);
  assert.match(overridden.origins["max_attempts"] ?? "", /^shared limits/);
  // Profiles never inherit shared native controls across runners.
  const native = loaded(
    'version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n[generation.native]\ncodex_only = true\n[generation.profiles.fast]\nrunner = "opencode"\nmodel = "m"\n',
  );
  const profiled = resolveRecipe(native, "given", null, { profile: "fast" });
  assert.deepEqual(profiled.native, {});
  // Explicit native maps replace wholesale.
  const replaced = resolveRecipe(native, "given", null, { native: { sandbox: "strict" } });
  assert.deepEqual(replaced.native, { sandbox: "strict" });
  assert.equal(replaced.origins["native"], "run override");
  // The frozen v1 runner set (no other ids).
  assert.deepEqual([...RUNNERS], ["codex", "muse", "claude-code", "opencode"]);
});

test("explicit declaration agent=frontend without a profile diagnoses", () => {
  // Shared recipe only: no `frontend` profile is configured.
  const plain = loaded('version = 1\n[generation]\nrunner = "codex"\nmodel = "m"\n');
  // An explicit owning-declaration `agent=frontend` names a profile
  // that must exist, so it diagnoses.
  assert.throws(
    () => resolveRecipe(plain, "frontend", "frontend", {}),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unknown-profile");
      assert.match(error.detail, /frontend/);
      return true;
    },
  );
  // An explicit run profile selection diagnoses the same way.
  assert.throws(
    () => resolveRecipe(plain, "frontend", null, { profile: "frontend" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, "unknown-profile");
      return true;
    },
  );
  // The implicit Then default still falls back to shared.
  const fallback = resolveRecipe(plain, "frontend", null, {});
  assert.equal(fallback.runner, "codex");
  assert.match(fallback.origins["runner"] ?? "", /^shared recipe/);
});

test("zero run limits refuse before recipe construction", () => {
  const found = loaded(SETTINGS);
  for (const overrides of [{ max_attempts: 0 }, { timeout_seconds: 0 }]) {
    assert.throws(
      () => resolveRecipe(found, "given", null, overrides),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.code, "invalid-settings");
        assert.match(error.detail, /positive finite integer/);
        return true;
      },
      JSON.stringify(overrides),
    );
  }
  // Explicit finite positive overrides still resolve.
  const resolved = resolveRecipe(found, "given", null, { max_attempts: 3, timeout_seconds: 45 });
  assert.equal(resolved.max_attempts, 3);
  assert.equal(resolved.timeout_seconds, 45);
  assert.equal(resolved.origins["max_attempts"], "run override");
  assert.equal(resolved.origins["timeout_seconds"], "run override");
});
