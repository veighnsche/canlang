//! BGI-03: `can.gen.toml` v1 settings, effective-recipe resolution and
//! native adapter capability tables.
//!
//! This module owns the configuration half of the `can gen` JSON
//! dispatcher contract: strict v1 TOML parsing (via the maintained
//! `toml` crate, never a hand-rolled parser), explicit settings-file
//! selection with no ambient search, complete runner/model profile
//! pairs, shared finite-limit reuse without an inheritance graph,
//! Given/frontend role defaults (ordinary When has no generator
//! recipe), explicit run-override precedence with per-field origins,
//! and pre-launch capability preflight (MCP attachment, generator
//! write restrictions, native options).
//!
//! The Node generation host mirrors these shapes in
//! `packages/cloudflare/src/generation/config.ts`; the two sides must
//! stay byte-compatible on accepted files and resolution outcomes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Generation protocol major version (requests, results, settings).
pub const GEN_PROTOCOL_VERSION: u32 = 1;
/// Settings filename at the explicitly supplied project root.
pub const SETTINGS_FILE: &str = "can.gen.toml";
/// Reserved Then profile name: used when configured, else shared.
pub const FRONTEND_PROFILE: &str = "frontend";
/// Built-in default: one bounded runner execution per request.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 1;
/// Built-in default: 600 seconds per requested execution.
pub const DEFAULT_TIMEOUT_SECONDS: u32 = 600;

/// Supported runner adapter ids (frozen v1 set).
pub const RUNNERS: [&str; 4] = ["codex", "muse", "claude-code", "opencode"];

/// Typed configuration failure. The dispatcher maps every variant to
/// exit 2 (`invalid request/config/selection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    /// Machine-readable code (`unknown-profile`, `invalid-settings`, ...).
    pub code: &'static str,
    /// Human-actionable detail naming the value and the fix.
    pub message: String,
}

impl ConfigError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Machine-readable failure code.
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ConfigError {}

/// Shared `[generation]` recipe. Runner/model are optional at parse:
/// a settings file may exist before generation is configured, and the
/// missing pair fails only when an execution resolves it. Ordinary
/// saved builds never consult this struct.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SharedRecipe {
    /// Selected CLI adapter id (must be a known runner when present).
    pub runner: Option<String>,
    /// Explicit model id for that runner (never inherited cross-runner).
    pub model: Option<String>,
    /// Finite attempt bound (built-in default 1 when omitted).
    pub max_attempts: Option<u32>,
    /// Finite per-execution timeout (built-in default 600 when omitted).
    pub timeout_seconds: Option<u32>,
    /// Flat scalar native options for the shared runner.
    pub native: BTreeMap<String, serde_json::Value>,
}

/// One complete `[generation.profiles.<name>]` runner/model pair.
/// Profiles are complete at parse: a profile missing either field is
/// a config error, never a partial inheritance row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRecipe {
    /// Selected CLI adapter id.
    pub runner: String,
    /// Explicit model id for that runner.
    pub model: String,
    /// Optional override; omitted limits reuse shared limits.
    pub max_attempts: Option<u32>,
    /// Optional override; omitted limits reuse shared limits.
    pub timeout_seconds: Option<u32>,
    /// Flat scalar native options for this profile's runner only.
    /// Shared native options are never inherited into a profile:
    /// native controls belong to the chosen recipe and adapter.
    pub native: BTreeMap<String, serde_json::Value>,
}

/// Parsed `can.gen.toml` v1: shared recipe plus complete named profiles.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GenerationSettings {
    /// Shared `[generation]` recipe (Given default; Then fallback).
    pub shared: SharedRecipe,
    /// Complete named `[generation.profiles.<name>]` pairs.
    pub profiles: BTreeMap<String, ProfileRecipe>,
}

/// Which settings file was selected (explicit `--settings` replaces
/// the root file; there is no ambient search).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsSource {
    /// `<root>/can.gen.toml` (the committed root file).
    RootFile(PathBuf),
    /// Explicit replacement file from the run request.
    ExplicitFile(PathBuf),
}

impl SettingsSource {
    /// Filesystem path of the selected settings file.
    pub fn path(&self) -> &Path {
        match self {
            SettingsSource::RootFile(path) | SettingsSource::ExplicitFile(path) => path,
        }
    }
}

/// Parsed settings with their selected source file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedSettings {
    /// Which file supplied these settings.
    pub source: SettingsSource,
    /// Parsed v1 settings.
    pub settings: GenerationSettings,
}

/// Parse `can.gen.toml` v1 text strictly: unknown tables/keys fail,
/// `version` must be 1, `[generation]` must exist, runners must be
/// known, models must be non-empty, profiles must be complete pairs,
/// and limits must be positive finite integers.
pub fn parse_settings_toml(text: &str) -> Result<GenerationSettings, ConfigError> {
    let table: toml::Table = text.parse().map_err(|err| {
        ConfigError::new(
            "invalid-settings",
            format!("settings TOML does not parse: {err}"),
        )
    })?;
    let mut table = table;
    let version = take_key(&mut table, "version", "settings root")?.ok_or_else(|| {
        ConfigError::new(
            "invalid-settings",
            "settings miss `version = 1`; the v1 schema requires it",
        )
    })?;
    let version = as_integer(&version, "version").ok_or_else(|| {
        ConfigError::new(
            "invalid-settings",
            "settings `version` must be the integer 1",
        )
    })?;
    if version != i64::from(GEN_PROTOCOL_VERSION) {
        return Err(ConfigError::new(
            "invalid-settings",
            format!("unsupported settings `version = {version}`; this dispatcher implements v1"),
        ));
    }
    let generation = take_key(&mut table, "generation", "settings root")?.ok_or_else(|| {
        ConfigError::new(
            "invalid-settings",
            "settings miss the `[generation]` table; the v1 schema requires it",
        )
    })?;
    let generation = as_table(generation, "[generation]")
        .ok_or_else(|| ConfigError::new("invalid-settings", "[generation] must be a table"))?;
    let mut generation = generation;
    let shared = parse_shared_recipe(&mut generation)?;
    let profiles = parse_profiles(&mut generation)?;
    reject_extra(
        &generation,
        "[generation]",
        &[
            "runner",
            "model",
            "max_attempts",
            "timeout_seconds",
            "native",
            "profiles",
        ],
    )?;
    reject_extra(&table, "settings root", &["version", "generation"])?;
    Ok(GenerationSettings { shared, profiles })
}

/// Select and load settings: an explicit file replaces
/// `<root>/can.gen.toml`; without one, the root file loads when
/// present. No ambient user/local/ancestor search ever runs: a
/// missing root file means unconfigured (`Ok(None)`), never an error.
pub fn load_settings(
    root: &Path,
    explicit: Option<&str>,
) -> Result<Option<LoadedSettings>, ConfigError> {
    if let Some(file) = explicit {
        if file.is_empty() {
            return Err(ConfigError::new(
                "invalid-settings",
                "an explicit settings file must be a non-empty path",
            ));
        }
        let path = resolve_against_root(root, file);
        let text = std::fs::read_to_string(&path).map_err(|err| {
            ConfigError::new(
                "settings-not-found",
                format!("cannot read settings '{}': {err}", path.display()),
            )
        })?;
        let settings = parse_settings_toml(&text).map_err(|err| {
            ConfigError::new(err.code, format!("{}: {}", path.display(), err.message))
        })?;
        return Ok(Some(LoadedSettings {
            source: SettingsSource::ExplicitFile(path),
            settings,
        }));
    }
    let path = root.join(SETTINGS_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(ConfigError::new(
                "settings-not-found",
                format!("cannot read settings '{}': {err}", path.display()),
            ));
        }
    };
    let settings = parse_settings_toml(&text).map_err(|err| {
        ConfigError::new(err.code, format!("{}: {}", path.display(), err.message))
    })?;
    Ok(Some(LoadedSettings {
        source: SettingsSource::RootFile(path),
        settings,
    }))
}

/// Resolve a request-relative path against the project root.
/// Absolute paths pass through; relative paths never consult the
/// process working directory, so machine-generated requests resolve
/// deterministically from their explicit root.
pub fn resolve_against_root(root: &Path, path: &str) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    }
}

fn take_key(
    table: &mut toml::Table,
    key: &str,
    where_: &str,
) -> Result<Option<toml::Value>, ConfigError> {
    if table.contains_key(key) {
        Ok(table.remove(key))
    } else {
        let _ = where_;
        Ok(None)
    }
}

fn as_table(value: toml::Value, what: &str) -> Option<toml::Table> {
    let _ = what;
    match value {
        toml::Value::Table(table) => Some(table),
        _ => None,
    }
}

fn as_integer(value: &toml::Value, _what: &str) -> Option<i64> {
    match value {
        toml::Value::Integer(int) => Some(*int),
        _ => None,
    }
}

fn reject_extra(table: &toml::Table, where_: &str, known: &[&str]) -> Result<(), ConfigError> {
    if let Some(extra) = table.keys().next() {
        return Err(ConfigError::new(
            "invalid-settings",
            format!(
                "unknown settings key `{extra}` in {where_}; known keys: {}",
                known.join(", ")
            ),
        ));
    }
    Ok(())
}

fn take_string(
    table: &mut toml::Table,
    key: &str,
    where_: &str,
) -> Result<Option<String>, ConfigError> {
    let Some(value) = take_key(table, key, where_)? else {
        return Ok(None);
    };
    match value {
        toml::Value::String(text) => Ok(Some(text)),
        _ => Err(ConfigError::new(
            "invalid-settings",
            format!("settings `{key}` in {where_} must be a string"),
        )),
    }
}

fn take_limit(
    table: &mut toml::Table,
    key: &str,
    where_: &str,
) -> Result<Option<u32>, ConfigError> {
    let Some(value) = take_key(table, key, where_)? else {
        return Ok(None);
    };
    match value {
        toml::Value::Integer(int) if int > 0 => u32::try_from(int).map(Some).map_err(|_| {
            ConfigError::new(
                "invalid-settings",
                format!("settings `{key}` in {where_} exceeds the finite u32 bound"),
            )
        }),
        _ => Err(ConfigError::new(
            "invalid-settings",
            format!("settings `{key}` in {where_} must be a positive finite integer"),
        )),
    }
}

fn take_native(
    table: &mut toml::Table,
    where_: &str,
) -> Result<BTreeMap<String, serde_json::Value>, ConfigError> {
    let Some(value) = take_key(table, "native", where_)? else {
        return Ok(BTreeMap::new());
    };
    let toml::Value::Table(entries) = value else {
        return Err(ConfigError::new(
            "invalid-settings",
            format!("settings `native` in {where_} must be a flat table of scalars"),
        ));
    };
    let mut native = BTreeMap::new();
    for (key, entry) in entries {
        let converted = match entry {
            toml::Value::String(text) => serde_json::Value::String(text),
            toml::Value::Integer(int) => serde_json::json!(int),
            toml::Value::Float(float) => serde_json::json!(float),
            toml::Value::Boolean(flag) => serde_json::Value::Bool(flag),
            _ => {
                return Err(ConfigError::new(
                    "invalid-settings",
                    format!(
                        "settings native option `{key}` in {where_} must be a scalar string, integer, float or boolean"
                    ),
                ));
            }
        };
        native.insert(key, converted);
    }
    Ok(native)
}

fn check_runner(runner: &str, where_: &str) -> Result<(), ConfigError> {
    if RUNNERS.contains(&runner) {
        return Ok(());
    }
    Err(ConfigError::new(
        "unknown-runner",
        format!(
            "unknown runner `{runner}` in {where_}; supported runners: {}",
            RUNNERS.join(", ")
        ),
    ))
}

fn check_model(model: &str, where_: &str) -> Result<(), ConfigError> {
    if model.trim().is_empty() {
        return Err(ConfigError::new(
            "invalid-settings",
            format!("settings `model` in {where_} must be a non-empty model id"),
        ));
    }
    Ok(())
}

fn parse_shared_recipe(table: &mut toml::Table) -> Result<SharedRecipe, ConfigError> {
    let runner = take_string(table, "runner", "[generation]")?;
    if let Some(runner) = &runner {
        check_runner(runner, "[generation]")?;
    }
    let model = take_string(table, "model", "[generation]")?;
    if let Some(model) = &model {
        check_model(model, "[generation]")?;
    }
    let max_attempts = take_limit(table, "max_attempts", "[generation]")?;
    let timeout_seconds = take_limit(table, "timeout_seconds", "[generation]")?;
    let native = take_native(table, "[generation]")?;
    Ok(SharedRecipe {
        runner,
        model,
        max_attempts,
        timeout_seconds,
        native,
    })
}

fn parse_profiles(
    generation: &mut toml::Table,
) -> Result<BTreeMap<String, ProfileRecipe>, ConfigError> {
    let Some(value) = take_key(generation, "profiles", "[generation]")? else {
        return Ok(BTreeMap::new());
    };
    let toml::Value::Table(profiles) = value else {
        return Err(ConfigError::new(
            "invalid-settings",
            "[generation.profiles] must be a table of complete runner/model pairs",
        ));
    };
    let mut parsed = BTreeMap::new();
    for (name, entry) in profiles {
        if name.is_empty() {
            return Err(ConfigError::new(
                "invalid-settings",
                "profile names must be non-empty",
            ));
        }
        let where_ = format!("[generation.profiles.{name}]");
        let toml::Value::Table(mut profile) = entry else {
            return Err(ConfigError::new(
                "invalid-settings",
                format!("{where_} must be a table with a complete runner/model pair"),
            ));
        };
        let runner = take_string(&mut profile, "runner", &where_)?.ok_or_else(|| {
            ConfigError::new(
                "invalid-settings",
                format!("{where_} misses `runner`; profile pairs are complete"),
            )
        })?;
        check_runner(&runner, &where_)?;
        let model = take_string(&mut profile, "model", &where_)?.ok_or_else(|| {
            ConfigError::new(
                "invalid-settings",
                format!("{where_} misses `model`; profile pairs are complete"),
            )
        })?;
        check_model(&model, &where_)?;
        let max_attempts = take_limit(&mut profile, "max_attempts", &where_)?;
        let timeout_seconds = take_limit(&mut profile, "timeout_seconds", &where_)?;
        let native = take_native(&mut profile, &where_)?;
        reject_extra(
            &profile,
            &where_,
            &[
                "runner",
                "model",
                "max_attempts",
                "timeout_seconds",
                "native",
            ],
        )?;
        parsed.insert(
            name,
            ProfileRecipe {
                runner,
                model,
                max_attempts,
                timeout_seconds,
                native,
            },
        );
    }
    Ok(parsed)
}

/// Generation category selecting the recipe default. Given uses the
/// shared recipe; Then uses the reserved `frontend` profile when
/// configured, else shared. Ordinary When has no generator recipe:
/// there is deliberately no third variant here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipeCategory {
    /// Given traits and custom keywords: the shared recipe.
    Given,
    /// Then styles and views: `frontend` when configured, else shared.
    Frontend,
}

/// Explicit per-run overrides. A runner override requires an explicit
/// compatible model (same request); models never cross runners
/// implicitly, and native maps replace wholesale (no merge).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunOverrides {
    /// Explicit run profile selecting a complete pair.
    pub profile: Option<String>,
    /// Explicit runner, requiring an explicit model in the same run.
    pub runner: Option<String>,
    /// Explicit model for the effective runner.
    pub model: Option<String>,
    /// Explicit finite attempt bound.
    pub max_attempts: Option<u32>,
    /// Explicit finite per-execution timeout.
    pub timeout_seconds: Option<u32>,
    /// Explicit native map replacing the recipe's table wholesale.
    pub native: Option<BTreeMap<String, serde_json::Value>>,
}

/// One resolved runner/model recipe with per-field origins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveRecipe {
    /// Resolved adapter id.
    pub runner: String,
    /// Resolved model id for that adapter.
    pub model: String,
    /// Resolved finite attempt bound.
    pub max_attempts: u32,
    /// Resolved finite per-execution timeout.
    pub timeout_seconds: u32,
    /// Resolved native map for the effective runner.
    pub native: BTreeMap<String, serde_json::Value>,
    /// Origin per field (`runner`, `model`, `max_attempts`,
    /// `timeout_seconds`, `native`).
    pub origins: BTreeMap<String, String>,
    /// Selected settings file, when any settings were consulted.
    pub settings: Option<PathBuf>,
    /// Which recipe row won: profile name, shared, or run overrides.
    pub recipe_source: String,
}

impl EffectiveRecipe {
    /// Machine-readable recipe payload for result envelopes.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "runner": self.runner,
            "model": self.model,
            "max_attempts": self.max_attempts,
            "timeout_seconds": self.timeout_seconds,
            "native": self.native,
            "origins": self.origins,
            "settings": self.settings.as_ref().map(|p| p.display().to_string()),
            "recipe_source": self.recipe_source,
        })
    }
}

/// Resolve the effective recipe: explicit run profile, else the
/// owning declaration's `agent`, else the category default
/// (frontend profile for Then, shared otherwise); explicit run
/// values override the selected recipe field by field. Every
/// effective value reports its origin.
///
/// `settings` is `None` when no settings file was selected: then
/// only a fully explicit run recipe (runner plus model) resolves,
/// with built-in finite limits.
pub fn resolve_recipe(
    loaded: Option<&LoadedSettings>,
    category: RecipeCategory,
    declaration_agent: Option<&str>,
    overrides: &RunOverrides,
) -> Result<EffectiveRecipe, ConfigError> {
    check_run_overrides(overrides)?;
    // Base recipe row: explicit run profile, else declaration agent,
    // else the category default (the frontend profile only when
    // settings exist to supply it, else shared). Unknown explicit
    // profiles diagnose; an unknown declaration agent is equally
    // explicit (it names a profile that must exist).
    let base_name: Option<String> = match (&overrides.profile, declaration_agent) {
        (Some(profile), _) => Some(profile.clone()),
        (None, Some(agent)) => Some(agent.to_string()),
        (None, None) if loaded.is_some() && matches!(category, RecipeCategory::Frontend) => {
            Some(FRONTEND_PROFILE.to_string())
        }
        (None, None) => None,
    };
    let settings_path = loaded.map(|found| found.source.path().to_path_buf());
    // Only the implicit Then category default falls back to shared
    // when no `frontend` profile is configured; an explicit
    // declaration `agent=frontend` (or run profile) names a profile
    // that must exist, so it diagnoses like any unknown profile.
    let (base_runner, base_model, base_attempts, base_timeout, base_native, base_label): BaseRow =
        resolve_base_row(
            loaded,
            base_name,
            declaration_agent,
            overrides.profile.as_deref(),
            &settings_path,
        )?;
    // Runner/model: overrides win, but a runner override requires an
    // explicit model in the same run (no cross-runner inheritance).
    // A model-only override keeps the base runner.
    if overrides.runner.is_some() && overrides.model.is_none() {
        return Err(ConfigError::new(
            "runner-override-needs-model",
            "a run runner override requires an explicit compatible model in the same run; models never carry across runners",
        ));
    }
    let mut origins = BTreeMap::new();
    let runner = resolve_recipe_identity(
        "runner",
        overrides.runner.as_ref(),
        base_runner,
        &base_label,
        &mut origins,
    )?;
    let model = resolve_recipe_identity(
        "model",
        overrides.model.as_ref(),
        base_model,
        &base_label,
        &mut origins,
    )?;
    let (max_attempts, attempts_origin) = resolve_recipe_limit(
        "max_attempts",
        overrides.max_attempts,
        base_attempts,
        DEFAULT_MAX_ATTEMPTS,
        &base_label,
        loaded,
    );
    origins.insert("max_attempts".to_string(), attempts_origin);
    let (timeout_seconds, timeout_origin) = resolve_recipe_limit(
        "timeout_seconds",
        overrides.timeout_seconds,
        base_timeout,
        DEFAULT_TIMEOUT_SECONDS,
        &base_label,
        loaded,
    );
    origins.insert("timeout_seconds".to_string(), timeout_origin);
    // Native maps replace wholesale: an explicit run map wins, else
    // the selected recipe's own table (profiles never inherit shared
    // native controls across runners).
    let (native, native_origin) = match &overrides.native {
        Some(map) => (map.clone(), "run override".to_string()),
        None => (base_native, base_label.clone()),
    };
    origins.insert("native".to_string(), native_origin);
    Ok(EffectiveRecipe {
        runner,
        model,
        max_attempts,
        timeout_seconds,
        native,
        origins,
        settings: settings_path,
        recipe_source: base_label,
    })
}

fn check_run_overrides(overrides: &RunOverrides) -> Result<(), ConfigError> {
    if let Some(runner) = &overrides.runner {
        check_runner(runner, "run overrides")?;
    }
    if let Some(model) = &overrides.model
        && model.trim().is_empty()
    {
        return Err(ConfigError::new(
            "invalid-settings",
            "run override `model` must be a non-empty model id",
        ));
    }
    if let Some(native) = &overrides.native {
        check_native_scalars(native)?;
    }
    // Per-run limits share the TOML positive-finite domain: zero is
    // outside it and refuses here, before any recipe construction or
    // runner launch. Explicit finite positive overrides still win.
    for (key, value) in [
        ("max_attempts", overrides.max_attempts),
        ("timeout_seconds", overrides.timeout_seconds),
    ] {
        if value == Some(0) {
            return Err(ConfigError::new(
                "invalid-settings",
                format!("run override `{key}` must be a positive finite integer"),
            ));
        }
    }
    Ok(())
}

fn resolve_base_row(
    loaded: Option<&LoadedSettings>,
    base_name: Option<String>,
    declaration_agent: Option<&str>,
    profile_override: Option<&str>,
    settings_path: &Option<PathBuf>,
) -> Result<BaseRow, ConfigError> {
    let describe_settings = || {
        settings_path
            .as_ref()
            .map(|p| format!(" ({})", p.display()))
            .unwrap_or_default()
    };
    match (loaded, base_name) {
        (Some(found), Some(name)) => match found.settings.profiles.get(&name) {
            Some(profile) => Ok((
                Some(profile.runner.clone()),
                Some(profile.model.clone()),
                profile.max_attempts.or(found.settings.shared.max_attempts),
                profile
                    .timeout_seconds
                    .or(found.settings.shared.timeout_seconds),
                profile.native.clone(),
                format!("profile '{name}'{}", describe_settings()),
            )),
            None if name == FRONTEND_PROFILE
                && profile_override.is_none()
                && declaration_agent.is_none() =>
            {
                Ok(shared_base(&found.settings.shared, &describe_settings))
            }
            None => {
                let known: Vec<&str> =
                    found.settings.profiles.keys().map(String::as_str).collect();
                let hint = if known.is_empty() {
                    "the settings define no profiles".to_string()
                } else {
                    format!("known profiles: {}", known.join(", "))
                };
                Err(ConfigError::new(
                    "unknown-profile",
                    format!(
                        "unknown profile '{name}'{hint_tail}; {hint}",
                        hint_tail = describe_settings()
                    ),
                ))
            }
        },
        (Some(found), None) => Ok(shared_base(&found.settings.shared, &describe_settings)),
        (None, Some(name)) => Err(ConfigError::new(
            "unknown-profile",
            format!(
                "unknown profile '{name}': no settings file supplies profiles (explicit run overrides still need no settings)"
            ),
        )),
        (None, None) => Ok((
            None,
            None,
            None,
            None,
            BTreeMap::new(),
            "run overrides".to_string(),
        )),
    }
}

fn resolve_recipe_identity(
    field: &str,
    override_value: Option<&String>,
    base_value: Option<String>,
    base_label: &str,
    origins: &mut BTreeMap<String, String>,
) -> Result<String, ConfigError> {
    match (override_value, base_value) {
        (Some(value), _) => {
            origins.insert(field.to_string(), "run override".to_string());
            Ok(value.clone())
        }
        (None, Some(value)) => {
            origins.insert(field.to_string(), base_label.to_string());
            Ok(value)
        }
        (None, None) => Err(ConfigError::new(
            "missing-recipe",
            format!(
                "no {field} resolves: configure shared `runner`/`model`, select a profile, or pass explicit run overrides"
            ),
        )),
    }
}

fn resolve_recipe_limit(
    key: &str,
    override_value: Option<u32>,
    base_value: Option<u32>,
    default: u32,
    base_label: &str,
    loaded: Option<&LoadedSettings>,
) -> (u32, String) {
    match (override_value, base_value) {
        (Some(value), _) => (value, "run override".to_string()),
        (None, Some(value)) => (value, limit_origin(base_label, loaded, key)),
        (None, None) => (default, "built-in default".to_string()),
    }
}

/// One unresolved base recipe row: runner, model, attempt/timeout
/// bounds, native map, and the human-readable row label.
type BaseRow = (
    Option<String>,
    Option<String>,
    Option<u32>,
    Option<u32>,
    BTreeMap<String, serde_json::Value>,
    String,
);

fn shared_base(shared: &SharedRecipe, describe_settings: &dyn Fn() -> String) -> BaseRow {
    (
        shared.runner.clone(),
        shared.model.clone(),
        shared.max_attempts,
        shared.timeout_seconds,
        shared.native.clone(),
        format!("shared recipe{}", describe_settings()),
    )
}

fn limit_origin(base_label: &str, loaded: Option<&LoadedSettings>, key: &str) -> String {
    // A profile row reuses shared finite limits when it omits them;
    // report the shared origin so callers see the reuse.
    if base_label.starts_with("profile '")
        && let Some(found) = loaded
    {
        let name = base_label
            .strip_prefix("profile '")
            .and_then(|rest| rest.split('\'').next())
            .unwrap_or_default();
        let omitted = found
            .settings
            .profiles
            .get(name)
            .is_some_and(|profile| match key {
                "max_attempts" => profile.max_attempts.is_none(),
                _ => profile.timeout_seconds.is_none(),
            });
        if omitted {
            return format!("shared limits ({})", found.source.path().display());
        }
    }
    base_label.to_string()
}

fn check_native_scalars(native: &BTreeMap<String, serde_json::Value>) -> Result<(), ConfigError> {
    for (key, value) in native {
        let scalar = value.is_string() || value.is_number() || value.is_boolean();
        if !scalar {
            return Err(ConfigError::new(
                "invalid-settings",
                format!(
                    "run override native option `{key}` must be a scalar string, number or boolean"
                ),
            ));
        }
    }
    Ok(())
}

/// Advertisement state of one required adapter capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityStatus {
    /// Qualified with the named evidence (adapter help/docs plus an
    /// observed bounded run); the capability may launch.
    Supported {
        /// What qualifies the claim (evidence pointer).
        detail: &'static str,
    },
    /// The adapter cannot provide this capability; selection fails
    /// before launch without a direct-file fallback.
    Unsupported {
        /// Why the adapter cannot provide it.
        reason: &'static str,
    },
    /// Claimed by neither success nor failure yet: the owning
    /// qualification gate has not released it, so selection fails
    /// before launch exactly like an unsupported capability.
    Unqualified {
        /// Owning gate and release condition.
        gate: &'static str,
    },
}

impl CapabilityStatus {
    /// Machine-readable state word for envelopes.
    pub fn state(&self) -> &'static str {
        match self {
            CapabilityStatus::Supported { .. } => "supported",
            CapabilityStatus::Unsupported { .. } => "unsupported",
            CapabilityStatus::Unqualified { .. } => "unqualified",
        }
    }

    /// Evidence, reason, or gate text for envelopes.
    pub fn note(&self) -> &'static str {
        match self {
            CapabilityStatus::Supported { detail } => detail,
            CapabilityStatus::Unsupported { reason } => reason,
            CapabilityStatus::Unqualified { gate } => gate,
        }
    }

    /// Machine-readable capability payload for envelopes.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({"state": self.state(), "note": self.note()})
    }
}

/// One documented native adapter control: the selected adapter
/// enforces exactly these keys, and unknown native keys fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeOptionSpec {
    /// Option key as it appears in `native` maps.
    pub name: &'static str,
    /// Accepted scalar kind (`string`, `integer`, `number`, `boolean`).
    pub kind: &'static str,
    /// What the control does and how the adapter enforces it.
    pub description: &'static str,
}

/// Native capability advertisement for one runner adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterCapabilities {
    /// Runner id (`codex`, `muse`, `claude-code`, `opencode`).
    pub id: &'static str,
    /// Human adapter label.
    pub label: &'static str,
    /// Executable names probed on PATH, in order (first hit wins).
    /// BGI-06 verifies these against installed tools; the probe
    /// reports the exact names it tried, never a silent pass.
    pub probe_binaries: &'static [&'static str],
    /// Custom generation-MCP attachment for context/submission.
    pub mcp_attachment: CapabilityStatus,
    /// Enforced generator write restrictions over protected
    /// source/current/candidate roots.
    pub write_restriction: CapabilityStatus,
    /// Recorded-session resume for a still-applicable capture.
    pub session_resume: CapabilityStatus,
    /// Documented native controls; unknown keys fail preflight.
    pub native_options: &'static [NativeOptionSpec],
}

impl AdapterCapabilities {
    /// Machine-readable capability payload for envelopes.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "label": self.label,
            "mcp_attachment": self.mcp_attachment.to_json(),
            "write_restriction": self.write_restriction.to_json(),
            "session_resume": self.session_resume.to_json(),
            "native_options": self.native_options.iter().map(|spec| {
                serde_json::json!({
                    "name": spec.name,
                    "kind": spec.kind,
                    "description": spec.description,
                })
            }).collect::<Vec<_>>(),
        })
    }
}

/// Codex is qualified by retained native MCP and protected-write observations.
/// Other required adapters remain gated until their own qualification; unknown
/// native keys refuse before launch. See output/prompt-pipeline/codex-qualification.json.
pub static ADAPTERS: &[AdapterCapabilities] = &[
    AdapterCapabilities {
        id: "codex",
        label: "Codex CLI",
        probe_binaries: &["codex"],
        mcp_attachment: CapabilityStatus::Supported {
            detail: "BGI-05 native macOS Codex 0.162.0-alpha.17.2, gpt-6.1-sol/medium: three host MCP submissions; output/prompt-pipeline/codex-qualification.json",
        },
        write_restriction: CapabilityStatus::Supported {
            detail: "BGI-05 native read-only sandbox denies source/current/candidate writes; isolated host tools; output/prompt-pipeline/codex-qualification.json",
        },
        session_resume: CapabilityStatus::Unsupported {
            reason: "Isolated ephemeral Codex generation has no persisted session; explicit new work is required",
        },
        native_options: &[NativeOptionSpec {
            name: "model_reasoning_effort",
            kind: "string",
            description: "Explicit Codex reasoning effort: low, medium, high, xhigh, max or ultra; model support remains a native CLI gate.",
        }],
    },
    AdapterCapabilities {
        id: "muse",
        label: "Muse Code",
        probe_binaries: &["muse"],
        mcp_attachment: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies the Muse MCP attachment with observed bounded runs",
        },
        write_restriction: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies Muse no-write enforcement over protected roots",
        },
        session_resume: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies Muse recorded-session resume",
        },
        native_options: &[],
    },
    AdapterCapabilities {
        id: "claude-code",
        label: "Claude Code",
        probe_binaries: &["claude", "claude-code"],
        mcp_attachment: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies the Claude Code MCP attachment with observed bounded runs",
        },
        write_restriction: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies Claude Code no-write enforcement over protected roots",
        },
        session_resume: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies Claude Code recorded-session resume",
        },
        native_options: &[],
    },
    AdapterCapabilities {
        id: "opencode",
        label: "OpenCode",
        probe_binaries: &["opencode"],
        mcp_attachment: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies the OpenCode MCP attachment with observed bounded runs",
        },
        write_restriction: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies OpenCode no-write enforcement over protected roots",
        },
        session_resume: CapabilityStatus::Unqualified {
            gate: "BGI-06 qualifies OpenCode recorded-session resume",
        },
        native_options: &[],
    },
];

/// Look up one adapter's capability advertisement by runner id.
pub fn adapter_capabilities(runner: &str) -> Option<&'static AdapterCapabilities> {
    ADAPTERS.iter().find(|adapter| adapter.id == runner)
}

/// Pre-launch gate for one effective recipe: the adapter must affirm
/// supported MCP attachment and enforceable write restrictions, and
/// every native key must be documented by that adapter. Unqualified
/// and unsupported capabilities fail identically before launch, with
/// no direct-file fallback. BGI-05 runs this per compatible-recipe
/// job before spawning any runner; the dispatcher runs it during
/// admission for single-recipe execution requests.
pub fn preflight_recipe(recipe: &EffectiveRecipe) -> Result<(), ConfigError> {
    let Some(adapter) = adapter_capabilities(&recipe.runner) else {
        return Err(ConfigError::new(
            "unknown-runner",
            format!(
                "unknown runner `{}`; supported runners: {}",
                recipe.runner,
                RUNNERS.join(", ")
            ),
        ));
    };
    for key in recipe.native.keys() {
        let known = adapter.native_options.iter().any(|spec| spec.name == key);
        if !known {
            let documented = if adapter.native_options.is_empty() {
                "no native options are documented yet".to_string()
            } else {
                format!(
                    "documented options: {}",
                    adapter
                        .native_options
                        .iter()
                        .map(|spec| spec.name)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            return Err(ConfigError::new(
                "unsupported-native-option",
                format!(
                    "unsupported native option `{key}` for runner `{}`; {documented}",
                    recipe.runner,
                ),
            ));
        }
    }
    if recipe.runner == "codex" {
        if let Some(value) = recipe.native.get("model_reasoning_effort") {
            if !matches!(
                value.as_str(),
                Some("low" | "medium" | "high" | "xhigh" | "max" | "ultra")
            ) {
                return Err(ConfigError::new(
                    "invalid-native-option",
                    "Codex model_reasoning_effort must be low, medium, high, xhigh, max or ultra",
                ));
            }
        }
    }
    check_launch_capability(
        &recipe.runner,
        "custom MCP attachment",
        &adapter.mcp_attachment,
    )?;
    check_launch_capability(
        &recipe.runner,
        "enforced generator write restrictions",
        &adapter.write_restriction,
    )?;
    Ok(())
}

/// Pre-launch gate for recorded-session resume: the launch gates
/// plus a supported resume capability.
pub fn preflight_resume(recipe: &EffectiveRecipe) -> Result<(), ConfigError> {
    preflight_recipe(recipe)?;
    let adapter = adapter_capabilities(&recipe.runner).expect("preflight checked the runner");
    check_launch_capability(
        &recipe.runner,
        "recorded-session resume",
        &adapter.session_resume,
    )?;
    Ok(())
}

fn check_launch_capability(
    runner: &str,
    what: &str,
    status: &CapabilityStatus,
) -> Result<(), ConfigError> {
    match status {
        CapabilityStatus::Supported { .. } => Ok(()),
        CapabilityStatus::Unsupported { reason } => Err(ConfigError::new(
            "unsupported-capability",
            format!(
                "runner `{runner}` cannot launch: {what} is unsupported ({reason}); refusing before launch without a direct-file fallback"
            ),
        )),
        CapabilityStatus::Unqualified { gate } => Err(ConfigError::new(
            "unsupported-capability",
            format!(
                "runner `{runner}` cannot launch: {what} is unqualified ({gate}); refusing before launch without a direct-file fallback"
            ),
        )),
    }
}
