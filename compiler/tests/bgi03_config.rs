//! BGI-03: configuration and JSON command contract.
//!
//! Covers the version-1 `can gen` dispatcher (stdin/`--request`
//! routing, typed operations/errors, exit codes, exclusive
//! instruction carriers), `can.gen.toml` v1 (shared/complete-profile
//! recipes, precedence, origins, no ambient search), native
//! capability tables with pre-launch preflight, the MCP
//! context/submission contract, and saved-build independence from
//! generation settings.

use canlang_compiler::analysis::generation::GenerationKind;
use canlang_compiler::analysis::generation_config::{
    ADAPTERS, LoadedSettings, RUNNERS, RecipeCategory, RunOverrides, SettingsSource,
    adapter_capabilities, load_settings, parse_settings_toml, preflight_recipe, resolve_recipe,
};
use canlang_compiler::analysis::generation_intake::{
    GENERATED_DIR, UNIT_FILE, UnitKind, scan_unit_ids,
};
use canlang_compiler::analysis::generation_protocol::{
    AllowedTarget, GenOperation, GenerationContext, McpRole, SubmissionEntry, allowed_outputs_for,
    error_envelope, handle_grammar_valid, ok_envelope, parse_request, progress_event,
    validate_submission_batch,
};
use canlang_compiler::cli::dispatch;
use canlang_compiler::source::{SourceId, sha256_hex};
use canlang_compiler::syntax::parse_source;
use std::collections::BTreeMap;

/// Small generation fixture. The `##` comments are ordinary
/// documentation: they never affect discovery or association.
const APP: &str = r#"app Tasks
## Named behavior stays discoverable beside documentation.
Given
 trait completable $"Add done:bool=false with Open/Done labels."
 Todo {title:text trim min=1 max=200} completable
## Inline attachments own one-off units without author names.
 Note {body:text} trait $"Add pinned:bool=false."
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
## Named styles generate once and share across uses.
 style TaskSurface $"Readable task surfaces."
 page / title="Todos" $"A calm workspace."
  list Todo as task $TaskSurface
"#;

const SETTINGS: &str = r#"version = 1

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
"#;

fn argv(parts: &[&str]) -> Vec<String> {
    let mut args = vec!["can".to_string()];
    args.extend(parts.iter().map(|part| part.to_string()));
    args
}

fn write_file(dir: &std::path::Path, name: &str, text: &str) -> String {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().to_string()
}

fn request_file(dir: &std::path::Path, name: &str, body: &str) -> String {
    write_file(dir, name, body)
}

fn envelope(stdout: &str) -> serde_json::Value {
    serde_json::from_str(stdout).expect("dispatcher prints one JSON envelope")
}

fn error_of(stdout: &str) -> (String, String) {
    let body = envelope(stdout);
    assert_eq!(body["ok"], false);
    assert_eq!(body["state"], "error");
    (
        body["error"]["code"].as_str().unwrap().to_string(),
        body["error"]["message"].as_str().unwrap().to_string(),
    )
}

fn discover_kinds(text: &str) -> Vec<GenerationKind> {
    let (tree, diags) = parse_source(SourceId(0), text);
    assert!(diags.is_empty(), "{diags:?}");
    canlang_compiler::analysis::generation::discover_generation(&tree, text)
        .descriptors
        .into_iter()
        .map(|descriptor| descriptor.kind)
        .collect()
}

#[test]
fn request_schema_validation() {
    // Not JSON.
    assert!(parse_request("{oops").unwrap_err().code == "invalid-json");
    // Not an object.
    assert!(parse_request("[1]").unwrap_err().code == "invalid-json");
    // Missing version / wrong version.
    assert!(
        parse_request(r#"{"request_id":"r1","operation":"doctor"}"#)
            .unwrap_err()
            .code
            == "missing-param"
    );
    assert!(
        parse_request(r#"{"version":2,"request_id":"r1","operation":"doctor"}"#)
            .unwrap_err()
            .code
            == "unsupported-version"
    );
    // Missing / empty request id.
    assert!(
        parse_request(r#"{"version":1,"operation":"doctor"}"#)
            .unwrap_err()
            .code
            == "missing-param"
    );
    assert!(
        parse_request(r#"{"version":1,"request_id":"  ","operation":"doctor"}"#)
            .unwrap_err()
            .code
            == "invalid-param"
    );
    // Missing / unknown operation.
    assert!(
        parse_request(r#"{"version":1,"request_id":"r1"}"#)
            .unwrap_err()
            .code
            == "missing-param"
    );
    let err =
        parse_request(r#"{"version":1,"request_id":"r1","operation":"teleport"}"#).unwrap_err();
    assert_eq!(err.code, "unknown-operation");
    assert!(err.message.contains("teleport"), "{}", err.message);
    // Every typed operation parses its wire name.
    for operation in GenOperation::ALL {
        assert_eq!(
            GenOperation::parse(operation.as_str()),
            Some(*operation),
            "{}",
            operation.as_str()
        );
    }
    assert_eq!(GenOperation::ALL.len(), 19);
}

#[test]
fn dispatcher_reports_schema_failures_as_envelopes() {
    let dir = tempfile::tempdir().unwrap();
    let request = request_file(
        dir.path(),
        "bad.json",
        r#"{"version":1,"operation":"doctor"}"#,
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2, "stderr: {}", result.stderr);
    assert!(result.stderr.is_empty(), "stderr: {}", result.stderr);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "missing-param");
    assert!(message.contains("request_id"), "{message}");
    // The envelope echoes the parsed operation.
    let body = envelope(&result.stdout);
    assert_eq!(body["operation"], "doctor");
    assert_eq!(body["version"], 1);
}

#[test]
fn unknown_fields_reject_per_operation() {
    // A recipe key on status (saved intake only) is unknown.
    let err = parse_request(
        r#"{"version":1,"request_id":"r1","operation":"status","root":".","files":["a.can"],"profile":"fast"}"#,
    )
    .unwrap_err();
    assert_eq!(err.code, "unknown-field");
    assert!(err.message.contains("profile"), "{}", err.message);
    // A typo on doctor is unknown.
    let err =
        parse_request(r#"{"version":1,"request_id":"r1","operation":"doctor","runer":"codex"}"#)
            .unwrap_err();
    assert_eq!(err.code, "unknown-field");
    assert!(err.message.contains("runer"), "{}", err.message);
    // An instruction carrier on generate (prepare/fresh modes) is unknown.
    let err = parse_request(
        r#"{"version":1,"request_id":"r1","operation":"generate","root":".","files":["a.can"],"mode":"fresh","instruction":"x"}"#,
    )
    .unwrap_err();
    assert_eq!(err.code, "unknown-field");
}

#[test]
fn exclusive_instruction_carriers() {
    let base = |carriers: &str| {
        format!(
            r#"{{"version":1,"request_id":"r1","operation":"refine","root":".","unit_id":"u1",{carriers}}}"#
        )
    };
    // Zero carriers refuse.
    assert_eq!(
        parse_request(&base(r#""accept":false"#)).unwrap_err().code,
        "exclusive-carrier"
    );
    // Two carriers refuse.
    assert_eq!(
        parse_request(&base(r#""instruction":"a","instruction_file":"b.txt""#))
            .unwrap_err()
            .code,
        "exclusive-carrier"
    );
    assert_eq!(
        parse_request(&base(r#""instruction":"a","instruction_stdin":true"#))
            .unwrap_err()
            .code,
        "exclusive-carrier"
    );
    // `instruction_stdin: false` selects no carrier.
    assert_eq!(
        parse_request(&base(r#""instruction_stdin":false"#))
            .unwrap_err()
            .code,
        "exclusive-carrier"
    );
    // Empty carriers refuse.
    assert_eq!(
        parse_request(&base(r#""instruction":"""#))
            .unwrap_err()
            .code,
        "invalid-param"
    );
    assert_eq!(
        parse_request(&base(r#""instruction_file":"""#))
            .unwrap_err()
            .code,
        "invalid-param"
    );
    // Each single carrier admits.
    assert!(parse_request(&base(r#""instruction":"do it""#)).is_ok());
    assert!(parse_request(&base(r#""instruction_file":"note.txt""#)).is_ok());
    assert!(parse_request(&base(r#""instruction_stdin":true"#)).is_ok());
}

#[test]
fn generate_retry_modes_and_scopes() {
    // generate requires prepare or fresh.
    let err = parse_request(
        r#"{"version":1,"request_id":"r1","operation":"generate","root":".","files":["a.can"],"mode":"vibes"}"#,
    )
    .unwrap_err();
    assert_eq!(err.code, "invalid-param");
    assert!(err.message.contains("prepare"), "{}", err.message);
    // generate needs exactly one scope.
    assert_eq!(
        parse_request(
            r#"{"version":1,"request_id":"r1","operation":"generate","root":".","mode":"fresh"}"#,
        )
        .unwrap_err()
        .code,
        "invalid-param"
    );
    assert_eq!(
        parse_request(
            r#"{"version":1,"request_id":"r1","operation":"generate","root":".","files":["a.can"],"unit_ids":["u1"],"mode":"fresh"}"#,
        )
        .unwrap_err()
        .code,
        "invalid-param"
    );
    assert_eq!(
        parse_request(
            r#"{"version":1,"request_id":"r1","operation":"generate","root":".","files":[],"mode":"fresh"}"#,
        )
        .unwrap_err()
        .code,
        "invalid-param"
    );
    // retry needs a non-empty source closure.
    assert_eq!(
        parse_request(
            r#"{"version":1,"request_id":"r1","operation":"retry","root":".","files":[]}"#
        )
        .unwrap_err()
        .code,
        "invalid-param"
    );
    assert!(
        parse_request(
            r#"{"version":1,"request_id":"r1","operation":"retry","root":".","files":["a.can"]}"#,
        )
        .is_ok()
    );
}

#[test]
fn selector_exclusivity_across_operations() {
    // inspect: exactly one of unit_id / file span.
    assert_eq!(
        parse_request(r#"{"version":1,"request_id":"r1","operation":"inspect","root":"."}"#)
            .unwrap_err()
            .code,
        "invalid-param"
    );
    assert_eq!(
        parse_request(r#"{"version":1,"request_id":"r1","operation":"inspect","root":".","unit_id":"u1","file":"a.can","start":1,"end":2}"#)
            .unwrap_err()
            .code,
        "invalid-param"
    );
    assert_eq!(
        parse_request(r#"{"version":1,"request_id":"r1","operation":"inspect","root":".","file":"a.can","start":2,"end":1}"#)
            .unwrap_err()
            .code,
        "invalid-param"
    );
    // accept / cancel / reset / validate: exclusive scopes.
    for (operation, params) in [
        (
            "accept",
            serde_json::json!({"root":".","unit_id":"u1","attempt":"a1"}),
        ),
        ("accept", serde_json::json!({"root":"."})),
        (
            "cancel",
            serde_json::json!({"root":".","session_id":"s","request":"r"}),
        ),
        ("cancel", serde_json::json!({"root":"."})),
        (
            "reset",
            serde_json::json!({"root":".","unit_id":"u1","attempt":"a1"}),
        ),
        ("reset", serde_json::json!({"root":"."})),
        (
            "validate",
            serde_json::json!({"root":".","unit_id":"u1","files":["a.can"]}),
        ),
        ("validate", serde_json::json!({"root":"."})),
        ("edit.begin", serde_json::json!({"root":"."})),
    ] {
        let mut request = serde_json::json!({"version":1,"request_id":"r1","operation":operation});
        for (key, value) in params.as_object().unwrap() {
            request[key] = value.clone();
        }
        let text = serde_json::to_string(&request).unwrap();
        assert_eq!(
            parse_request(&text).unwrap_err().code,
            "invalid-param",
            "{operation} {text}"
        );
    }
    // bind spans stay ordered.
    assert_eq!(
        parse_request(r#"{"version":1,"request_id":"r1","operation":"bind","root":".","file":"a.can","start":9,"end":2,"revision":"r","unit":"new"}"#)
            .unwrap_err()
            .code,
        "invalid-param"
    );
}

#[test]
fn settings_toml_schema_is_strict() {
    // The documented shape parses.
    let settings = parse_settings_toml(SETTINGS).unwrap();
    assert_eq!(settings.shared.runner.as_deref(), Some("codex"));
    assert_eq!(settings.shared.model.as_deref(), Some("shared-model"));
    assert_eq!(settings.shared.max_attempts, Some(2));
    assert_eq!(settings.shared.timeout_seconds, Some(300));
    assert_eq!(settings.profiles.len(), 2);
    assert_eq!(settings.profiles["fast"].runner, "opencode");
    // Unknown keys fail at every level.
    for bad in [
        "version = 1\napp = \"x\"\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n",
        "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\nruner = \"x\"\n",
        "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n[generation.profiles.fast]\nrunner = \"opencode\"\nmodel = \"m\"\nextra = 1\n",
        "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n[generation.surprise]\n",
    ] {
        let err = parse_settings_toml(bad).unwrap_err();
        assert_eq!(err.code(), "invalid-settings", "{bad}");
        assert!(err.to_string().contains("unknown"), "{bad}: {err}");
    }
    // Version and table shape.
    assert!(parse_settings_toml("[generation]\nrunner = \"codex\"\nmodel = \"m\"\n").is_err());
    assert!(
        parse_settings_toml("version = 2\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n")
            .is_err()
    );
    assert!(parse_settings_toml("version = 1\n").is_err());
    assert!(parse_settings_toml("version = 1\ngeneration = 7\n").is_err());
    // Unknown runners fail fast.
    let err =
        parse_settings_toml("version = 1\n[generation]\nrunner = \"teleport\"\nmodel = \"m\"\n")
            .unwrap_err();
    assert_eq!(err.code(), "unknown-runner");
    assert!(err.to_string().contains("teleport"), "{err}");
    // Empty models fail.
    assert!(
        parse_settings_toml("version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"  \"\n")
            .is_err()
    );
    // Profiles are complete pairs.
    assert!(
        parse_settings_toml(
            "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n[generation.profiles.half]\nrunner = \"opencode\"\n",
        )
        .is_err()
    );
    assert!(
        parse_settings_toml(
            "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n[generation.profiles.half]\nmodel = \"m\"\n",
        )
        .is_err()
    );
    // Limits are positive finite integers.
    for bad_limit in ["0", "-3", "\"many\"", "1.5"] {
        let text = format!(
            "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\nmax_attempts = {bad_limit}\n"
        );
        assert!(
            parse_settings_toml(&text).is_err(),
            "max_attempts = {bad_limit}"
        );
    }
    // Native tables stay flat scalars.
    assert!(
        parse_settings_toml(
            "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n[generation.native]\ndeep = {a = 1}\n",
        )
        .is_err()
    );
    let settings = parse_settings_toml(
        "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n[generation.native]\nflag = true\nlevel = 3\nname = \"x\"\n",
    )
    .unwrap();
    assert_eq!(settings.shared.native.len(), 3);
}

#[test]
fn settings_selection_replaces_without_ambient_search() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    // An ancestor file is never consulted: no ambient search.
    write_file(
        dir.path(),
        "can.gen.toml",
        "version = 1\n[generation]\nrunner = \"muse\"\nmodel = \"ancestor\"\n",
    );
    // Missing root file means unconfigured, not an error.
    assert!(load_settings(&root, None).unwrap().is_none());
    // The root file loads when present.
    write_file(&root, "can.gen.toml", SETTINGS);
    let loaded = load_settings(&root, None).unwrap().unwrap();
    assert!(matches!(loaded.source, SettingsSource::RootFile(_)));
    assert_eq!(loaded.settings.shared.runner.as_deref(), Some("codex"));
    // An explicit file replaces the root file; relative paths resolve at root.
    write_file(
        &root,
        "alt.toml",
        "version = 1\n[generation]\nrunner = \"opencode\"\nmodel = \"alt\"\n",
    );
    let loaded = load_settings(&root, Some("alt.toml")).unwrap().unwrap();
    assert!(matches!(loaded.source, SettingsSource::ExplicitFile(_)));
    assert_eq!(loaded.settings.shared.runner.as_deref(), Some("opencode"));
    // A missing explicit file is a loud error, never a silent fallback.
    let err = load_settings(&root, Some("missing.toml")).unwrap_err();
    assert_eq!(err.code(), "settings-not-found");
    // A broken explicit file reports its path.
    write_file(&root, "broken.toml", "version = 1\n[generation\n");
    let err = load_settings(&root, Some("broken.toml")).unwrap_err();
    assert_eq!(err.code(), "invalid-settings");
    assert!(err.to_string().contains("broken.toml"), "{err}");
}

#[test]
fn unknown_profiles_diagnose() {
    let settings = parse_settings_toml(SETTINGS).unwrap();
    let loaded = LoadedSettings {
        source: SettingsSource::RootFile("can.gen.toml".into()),
        settings,
    };
    let overrides = RunOverrides {
        profile: Some("nope".to_string()),
        ..RunOverrides::default()
    };
    let err = resolve_recipe(Some(&loaded), RecipeCategory::Given, None, &overrides).unwrap_err();
    assert_eq!(err.code(), "unknown-profile");
    assert!(err.to_string().contains("nope"), "{err}");
    assert!(err.to_string().contains("fast"), "{err}");
    // Unknown declaration agents diagnose the same way.
    let err = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Given,
        Some("ghost"),
        &RunOverrides::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "unknown-profile");
    // Profiles without settings diagnose too.
    let err = resolve_recipe(None, RecipeCategory::Given, None, &overrides).unwrap_err();
    assert_eq!(err.code(), "unknown-profile");
}

#[test]
fn runner_override_requires_explicit_model() {
    let settings = parse_settings_toml(SETTINGS).unwrap();
    let loaded = LoadedSettings {
        source: SettingsSource::RootFile("can.gen.toml".into()),
        settings,
    };
    // Runner alone: no cross-runner inheritance.
    let overrides = RunOverrides {
        runner: Some("opencode".to_string()),
        ..RunOverrides::default()
    };
    let err = resolve_recipe(Some(&loaded), RecipeCategory::Given, None, &overrides).unwrap_err();
    assert_eq!(err.code(), "runner-override-needs-model");
    // Runner plus explicit model resolves.
    let overrides = RunOverrides {
        runner: Some("opencode".to_string()),
        model: Some("other-model".to_string()),
        ..RunOverrides::default()
    };
    let resolved = resolve_recipe(Some(&loaded), RecipeCategory::Given, None, &overrides).unwrap();
    assert_eq!(resolved.runner, "opencode");
    assert_eq!(resolved.model, "other-model");
    assert_eq!(resolved.origins["runner"], "run override");
    assert_eq!(resolved.origins["model"], "run override");
    // A model-only override keeps the base runner.
    let overrides = RunOverrides {
        model: Some("new-model".to_string()),
        ..RunOverrides::default()
    };
    let resolved = resolve_recipe(Some(&loaded), RecipeCategory::Given, None, &overrides).unwrap();
    assert_eq!(resolved.runner, "codex");
    assert_eq!(resolved.model, "new-model");
    // Full overrides resolve with no settings at all.
    let resolved = resolve_recipe(
        None,
        RecipeCategory::Frontend,
        None,
        &RunOverrides {
            runner: Some("codex".to_string()),
            model: Some("m".to_string()),
            ..RunOverrides::default()
        },
    )
    .unwrap();
    assert_eq!(resolved.max_attempts, 1);
    assert_eq!(resolved.timeout_seconds, 600);
    assert_eq!(resolved.origins["max_attempts"], "built-in default");
    // Nothing anywhere is a missing recipe, not a silent default.
    let err =
        resolve_recipe(None, RecipeCategory::Given, None, &RunOverrides::default()).unwrap_err();
    assert_eq!(err.code(), "missing-recipe");
}

fn loaded_settings(text: &str) -> LoadedSettings {
    LoadedSettings {
        source: SettingsSource::RootFile("can.gen.toml".into()),
        settings: parse_settings_toml(text).unwrap(),
    }
}

#[test]
fn effective_values_origins_and_role_defaults() {
    let loaded = loaded_settings(SETTINGS);
    // Given uses the shared recipe.
    let resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Given,
        None,
        &RunOverrides::default(),
    )
    .unwrap();
    assert_eq!(resolved.runner, "codex");
    assert_eq!(resolved.model, "shared-model");
    assert_eq!(resolved.max_attempts, 2);
    assert_eq!(resolved.timeout_seconds, 300);
    assert!(
        resolved.origins["runner"].starts_with("shared recipe"),
        "{}",
        resolved.origins["runner"]
    );
    // Then uses the reserved frontend profile when configured.
    let resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Frontend,
        None,
        &RunOverrides::default(),
    )
    .unwrap();
    assert_eq!(resolved.runner, "muse");
    assert_eq!(resolved.model, "front-model");
    assert_eq!(resolved.timeout_seconds, 120);
    // The frontend profile reuses shared max_attempts, and says so.
    assert_eq!(resolved.max_attempts, 2);
    assert!(
        resolved.origins["max_attempts"].starts_with("shared limits"),
        "{}",
        resolved.origins["max_attempts"]
    );
    // Then falls back to shared when no frontend profile exists.
    let plain = loaded_settings("version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n");
    let resolved = resolve_recipe(
        Some(&plain),
        RecipeCategory::Frontend,
        None,
        &RunOverrides::default(),
    )
    .unwrap();
    assert_eq!(resolved.runner, "codex");
    assert!(
        resolved.origins["runner"].starts_with("shared recipe"),
        "{}",
        resolved.origins["runner"]
    );
    // Explicit run profiles beat declaration agents and defaults.
    let resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Frontend,
        Some("frontend"),
        &RunOverrides {
            profile: Some("fast".to_string()),
            ..RunOverrides::default()
        },
    )
    .unwrap();
    assert_eq!(resolved.runner, "opencode");
    assert!(
        resolved.origins["runner"].starts_with("profile 'fast'"),
        "{}",
        resolved.origins["runner"]
    );
    // Declaration agents beat category defaults.
    let resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Frontend,
        Some("fast"),
        &RunOverrides::default(),
    )
    .unwrap();
    assert_eq!(resolved.runner, "opencode");
    // Overrides beat the selected profile field by field.
    let resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Given,
        None,
        &RunOverrides {
            profile: Some("fast".to_string()),
            timeout_seconds: Some(45),
            ..RunOverrides::default()
        },
    )
    .unwrap();
    assert_eq!(resolved.runner, "opencode");
    assert_eq!(resolved.timeout_seconds, 45);
    assert_eq!(resolved.origins["timeout_seconds"], "run override");
    assert_eq!(resolved.max_attempts, 2);
    assert!(
        resolved.origins["max_attempts"].starts_with("shared limits"),
        "{}",
        resolved.origins["max_attempts"]
    );
    // Profiles never inherit shared native controls across runners.
    let native = loaded_settings(
        "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n[generation.native]\ncodex_only = true\n[generation.profiles.fast]\nrunner = \"opencode\"\nmodel = \"m\"\n",
    );
    let resolved = resolve_recipe(
        Some(&native),
        RecipeCategory::Given,
        None,
        &RunOverrides {
            profile: Some("fast".to_string()),
            ..RunOverrides::default()
        },
    )
    .unwrap();
    assert!(resolved.native.is_empty(), "{:?}", resolved.native);
    // Explicit native maps replace wholesale.
    let mut replacement = BTreeMap::new();
    replacement.insert("sandbox".to_string(), serde_json::json!("strict"));
    let resolved = resolve_recipe(
        Some(&native),
        RecipeCategory::Given,
        None,
        &RunOverrides {
            native: Some(replacement),
            ..RunOverrides::default()
        },
    )
    .unwrap();
    assert_eq!(resolved.native.len(), 1);
    assert_eq!(resolved.origins["native"], "run override");
}

#[test]
fn capability_tables_advertise_all_required_adapters() {
    assert_eq!(RUNNERS, ["codex", "muse", "claude-code", "opencode"]);
    assert_eq!(ADAPTERS.len(), 4);
    for runner in RUNNERS {
        let adapter = adapter_capabilities(runner).unwrap_or_else(|| panic!("{runner}"));
        assert_eq!(adapter.id, runner);
        assert!(!adapter.probe_binaries.is_empty(), "{runner}");
        // Only the implemented Codex adapter may launch.
        let state = if runner == "codex" {
            "supported"
        } else {
            "unsupported"
        };
        assert_eq!(adapter.mcp_attachment.state(), state);
        assert_eq!(adapter.write_restriction.state(), state);
    }
    assert!(adapter_capabilities("teleport").is_none());
}

#[test]
fn preflight_refuses_before_launch() {
    let loaded = loaded_settings(SETTINGS);
    let mut resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Given,
        None,
        &RunOverrides::default(),
    )
    .unwrap();
    assert!(preflight_recipe(&resolved).is_ok());
    resolved.runner = "muse".into();
    // Missing MCP integration fails before launch, without fallback.
    let err = preflight_recipe(&resolved).unwrap_err();
    assert_eq!(err.code(), "unsupported-capability");
    assert!(err.to_string().contains("MCP"), "{err}");
    assert!(err.to_string().contains("before launch"), "{err}");
    // Unknown native options fail with the documented set.
    let mut native = BTreeMap::new();
    native.insert("mystery".to_string(), serde_json::json!(true));
    let resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Given,
        None,
        &RunOverrides {
            native: Some(native),
            ..RunOverrides::default()
        },
    )
    .unwrap();
    let err = preflight_recipe(&resolved).unwrap_err();
    assert_eq!(err.code(), "unsupported-native-option");
    assert!(err.to_string().contains("mystery"), "{err}");
    // Unknown runners fail even when constructed directly.
    let mut forged = resolved.clone();
    forged.runner = "teleport".to_string();
    assert_eq!(
        preflight_recipe(&forged).unwrap_err().code(),
        "unknown-runner"
    );
}

#[test]
fn mcp_contract_names_server_issued_targets_only() {
    let context = GenerationContext {
        session: "s1".to_string(),
        attempt: "a1".to_string(),
        source_digest: "d0".to_string(),
        instructions: None,
        allowed: vec![
            AllowedTarget {
                handle: "t-style-1".to_string(),
                role: McpRole::Style,
                kind: "style".to_string(),
                filename: "style.css".to_string(),
            },
            AllowedTarget {
                handle: "t_asset_2".to_string(),
                role: McpRole::Asset,
                kind: "style".to_string(),
                filename: "asset.bin".to_string(),
            },
        ],
    };
    let entry =
        |target: &str, role: &str, text: Option<&str>, blob: Option<&str>| SubmissionEntry {
            target: target.to_string(),
            role: role.to_string(),
            content_text: text.map(str::to_string),
            content_base64: blob.map(str::to_string),
        };
    // A well-formed batch validates: text plus checked base64.
    let matched = validate_submission_batch(
        &context,
        "s1",
        &[
            entry("t-style-1", "style", Some(".a{color:red}"), None),
            entry("t_asset_2", "asset", None, Some("aGk=")),
        ],
    )
    .unwrap();
    assert_eq!(matched.len(), 2);
    // Stale sessions, empty batches, and unknown handles refuse.
    assert_eq!(
        validate_submission_batch(
            &context,
            "s2",
            &[entry("t-style-1", "style", Some("x"), None)]
        )
        .unwrap_err()
        .code,
        "stale-session"
    );
    assert_eq!(
        validate_submission_batch(&context, "s1", &[])
            .unwrap_err()
            .code,
        "empty-batch"
    );
    assert_eq!(
        validate_submission_batch(&context, "s1", &[entry("t-nope", "style", Some("x"), None)])
            .unwrap_err()
            .code,
        "unknown-target"
    );
    // Arbitrary paths refuse as paths, never as missing handles.
    for path in [
        "../evil.js",
        "can.generated/u1/server.js",
        "C:\\win\\x.js",
        "..",
    ] {
        let err =
            validate_submission_batch(&context, "s1", &[entry(path, "style", Some("x"), None)])
                .unwrap_err();
        assert_eq!(err.code, "arbitrary-path", "{path}");
    }
    // Roles must match issuance.
    assert_eq!(
        validate_submission_batch(
            &context,
            "s1",
            &[entry("t-style-1", "server", Some("x"), None)]
        )
        .unwrap_err()
        .code,
        "role-mismatch"
    );
    // Content is exactly one well-formed payload.
    assert_eq!(
        validate_submission_batch(
            &context,
            "s1",
            &[entry("t-style-1", "style", Some("x"), Some("aGk="))]
        )
        .unwrap_err()
        .code,
        "malformed-content"
    );
    assert_eq!(
        validate_submission_batch(&context, "s1", &[entry("t-style-1", "style", None, None)])
            .unwrap_err()
            .code,
        "malformed-content"
    );
    assert_eq!(
        validate_submission_batch(
            &context,
            "s1",
            &[entry("t-style-1", "style", Some(""), None)]
        )
        .unwrap_err()
        .code,
        "malformed-content"
    );
    assert_eq!(
        validate_submission_batch(
            &context,
            "s1",
            &[entry("t_asset_2", "asset", None, Some("!!!"))]
        )
        .unwrap_err()
        .code,
        "malformed-content"
    );
    // Duplicate targets within one batch refuse.
    assert_eq!(
        validate_submission_batch(
            &context,
            "s1",
            &[
                entry("t-style-1", "style", Some("x"), None),
                entry("t-style-1", "style", Some("y"), None),
            ],
        )
        .unwrap_err()
        .code,
        "duplicate-target"
    );
    // Handle grammar admits opaque tokens only.
    assert!(handle_grammar_valid("t-style-1"));
    assert!(!handle_grammar_valid(""));
    assert!(!handle_grammar_valid("has space"));
    assert!(!handle_grammar_valid("has/slash"));
    // Admitted outputs derive from checked unit kinds.
    let style: Vec<_> = allowed_outputs_for(UnitKind::Style)
        .iter()
        .map(|(role, _)| *role)
        .collect();
    assert_eq!(style, vec![McpRole::Style, McpRole::Asset]);
    let view: Vec<_> = allowed_outputs_for(UnitKind::View)
        .iter()
        .map(|(role, _)| *role)
        .collect();
    assert_eq!(
        view,
        vec![
            McpRole::Server,
            McpRole::Browser,
            McpRole::Style,
            McpRole::Asset
        ]
    );
    let keyword: Vec<_> = allowed_outputs_for(UnitKind::Keyword)
        .iter()
        .map(|(role, _)| *role)
        .collect();
    assert_eq!(keyword, vec![McpRole::Server]);
    for kind in [UnitKind::NamedTrait, UnitKind::InlineTrait] {
        assert_eq!(
            allowed_outputs_for(kind),
            &[(McpRole::Contributions, "contributions.can")]
        );
    }
}

#[test]
fn doctor_reports_adapters_recipe_and_verdict() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    // No selectors and no settings: all four adapters, no recipe, blocked verdict.
    let request = request_file(
        dir.path(),
        "doctor.json",
        &format!(r#"{{"version":1,"request_id":"d0","operation":"doctor","root":{root:?}}}"#),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stderr: {}", result.stderr);
    let body = envelope(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["state"], "reported");
    assert_eq!(body["adapters"].as_array().unwrap().len(), 4);
    assert_eq!(body["verdict"], "blocked");
    assert!(
        body["blockers"][0]
            .as_str()
            .unwrap()
            .contains("no recipe selected"),
        "{}",
        body["blockers"]
    );
    // A selected recipe reports effective values, origins, and gates.
    write_file(dir.path(), "can.gen.toml", SETTINGS);
    let request = request_file(
        dir.path(),
        "doctor.json",
        &format!(
            r#"{{"version":1,"request_id":"d1","operation":"doctor","root":{root:?},"profile":"fast"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stderr: {}", result.stderr);
    let body = envelope(&result.stdout);
    assert_eq!(body["recipe"]["runner"], "opencode");
    assert_eq!(body["recipe"]["model"], "fast-model");
    assert!(
        body["recipe"]["origins"]["runner"]
            .as_str()
            .unwrap()
            .starts_with("profile 'fast'")
    );
    assert_eq!(body["preflight"]["ok"], false);
    assert!(
        body["preflight"]["failures"][0]
            .as_str()
            .unwrap()
            .contains("MCP"),
        "{}",
        body["preflight"]
    );
    assert_eq!(body["verdict"], "blocked");
    // Resolution failures report inside a successful doctor envelope.
    let request = request_file(
        dir.path(),
        "doctor.json",
        &format!(
            r#"{{"version":1,"request_id":"d2","operation":"doctor","root":{root:?},"profile":"nope"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stderr: {}", result.stderr);
    let body = envelope(&result.stdout);
    assert_eq!(body["recipe_error"]["code"], "unknown-profile");
    assert_eq!(body["verdict"], "blocked");
    // Broken settings fail the check itself.
    write_file(dir.path(), "broken.toml", "version = 1\n[generation\n");
    let request = request_file(
        dir.path(),
        "doctor.json",
        &format!(
            r#"{{"version":1,"request_id":"d3","operation":"doctor","root":{root:?},"settings":"broken.toml"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2, "stdout: {}", result.stdout);
    let (code, _) = error_of(&result.stdout);
    assert_eq!(code, "invalid-settings");
}

#[test]
fn saved_builds_ignore_generation_settings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    // Garbage settings must not disturb saved intake or ordinary builds.
    write_file(dir.path(), "can.gen.toml", "this is not [toml\n");
    let request = request_file(
        dir.path(),
        "status.json",
        &format!(
            r#"{{"version":1,"request_id":"s1","operation":"status","root":{root:?},"files":[{file:?}]}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["state"], "reported");
    assert!(
        body["units"]
            .as_array()
            .unwrap()
            .iter()
            .any(|unit| unit["association"] == "new"),
        "{}",
        body["units"]
    );
    // Ordinary `check` is equally independent of generation settings.
    let result = dispatch(&argv(&["check", &file]));
    assert!(
        result.code == 0 || result.code == 10,
        "check must run (0 or diagnostics 10), got {}: {}",
        result.code,
        result.stderr
    );
    assert!(
        !result.stdout.contains("can.gen.toml") && !result.stderr.contains("can.gen.toml"),
        "settings leak into ordinary builds: {}{}",
        result.stdout,
        result.stderr
    );
    // Discovery still sees every generation carrier beside ## comments.
    let kinds = discover_kinds(APP);
    assert!(kinds.contains(&GenerationKind::NamedTrait), "{kinds:?}");
    assert!(
        kinds.contains(&GenerationKind::StyleDefinition),
        "{kinds:?}"
    );
}

#[test]
fn status_json_matches_positional_report() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    let request = request_file(
        dir.path(),
        "status.json",
        &format!(
            r#"{{"version":1,"request_id":"s1","operation":"status","root":{root:?},"files":[{file:?}]}}"#
        ),
    );
    let via_json = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(via_json.code, 0, "stdout: {}", via_json.stdout);
    let body = envelope(&via_json.stdout);
    let positional = dispatch(&argv(&["gen", "status", "--format=json", &root, &file]));
    assert_eq!(positional.code, 0, "stderr: {}", positional.stderr);
    let plain: serde_json::Value = serde_json::from_str(&positional.stdout).unwrap();
    assert_eq!(body["units"], plain["units"]);
    assert_eq!(body["issues"], plain["issues"]);
    // Unreadable sources fail closed.
    let request = request_file(
        dir.path(),
        "status.json",
        &format!(
            r#"{{"version":1,"request_id":"s2","operation":"status","root":{root:?},"files":["missing.can"]}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "unreadable-input");
}

#[test]
fn bind_json_round_trip_with_typed_errors() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    let revision = sha256_hex(APP.as_bytes());
    let (tree, _) = parse_source(SourceId(0), APP);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, APP);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let request = request_file(
        dir.path(),
        "bind.json",
        &format!(
            r#"{{"version":1,"request_id":"b1","operation":"bind","root":{root:?},"file":{file:?},"start":{},"end":{},"revision":{revision:?},"unit":"new"}}"#,
            descriptor.span.start, descriptor.span.end,
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["state"], "bound");
    let unit_id = body["unit"]["id"].as_str().unwrap();
    assert_random_unit_id(unit_id);
    assert!(
        dir.path()
            .join(GENERATED_DIR)
            .join(unit_id)
            .join(UNIT_FILE)
            .is_file()
    );
    // Stale revisions refuse with a typed error and write nothing new.
    let request = request_file(
        dir.path(),
        "bind.json",
        &format!(
            r#"{{"version":1,"request_id":"b2","operation":"bind","root":{root:?},"file":{file:?},"start":{},"end":{},"revision":"deadbeef","unit":"new"}}"#,
            descriptor.span.start, descriptor.span.end,
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "stale-selector");
    assert!(message.contains("stale"), "{message}");
    assert_eq!(
        scan_unit_ids(dir.path()).unwrap(),
        vec![unit_id.to_string()]
    );
    // Unknown units refuse without touching saved groups.
    let request = request_file(
        dir.path(),
        "bind.json",
        &format!(
            r#"{{"version":1,"request_id":"b3","operation":"bind","root":{root:?},"file":{file:?},"start":{},"end":{},"revision":{revision:?},"unit":"u9"}}"#,
            descriptor.span.start, descriptor.span.end,
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "unknown-unit");
}

#[test]
fn inspect_reports_unit_contracts_and_recipe() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    write_file(dir.path(), "can.gen.toml", SETTINGS);
    // Bind the style first so both selectors resolve.
    let revision = sha256_hex(APP.as_bytes());
    let (tree, _) = parse_source(SourceId(0), APP);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, APP);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let bound = dispatch(&argv(&[
        "gen",
        "bind",
        &root,
        &file,
        &descriptor.span.start.to_string(),
        &descriptor.span.end.to_string(),
        &revision,
        "new",
    ]));
    assert_eq!(bound.code, 0, "stderr: {}", bound.stderr);
    let unit_id = positional_bound_id(&bound.stdout);
    // By unit id: contracts, paths, and the frontend recipe.
    let request = request_file(
        dir.path(),
        "inspect.json",
        &format!(
            r#"{{"version":1,"request_id":"i1","operation":"inspect","root":{root:?},"unit_id":{unit_id:?}}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["unit"]["id"], unit_id);
    assert_eq!(body["unit"]["kind"], "style");
    assert_eq!(body["unit"]["association"], "retained");
    assert!(
        body["unit"]["paths"]["current"]
            .as_str()
            .unwrap()
            .contains(&format!("can.generated/{unit_id}"))
    );
    assert_eq!(body["recipe"]["runner"], "muse");
    assert!(
        body["recipe"]["origins"]["runner"]
            .as_str()
            .unwrap()
            .starts_with("profile 'frontend'")
    );
    // By source span: same unit.
    let request = request_file(
        dir.path(),
        "inspect.json",
        &format!(
            r#"{{"version":1,"request_id":"i2","operation":"inspect","root":{root:?},"file":{file:?},"start":{},"end":{}}}"#,
            descriptor.span.start, descriptor.span.end,
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    assert_eq!(envelope(&result.stdout)["unit"]["id"], unit_id);
    // Unknown units and empty spans diagnose.
    let request = request_file(
        dir.path(),
        "inspect.json",
        &format!(
            r#"{{"version":1,"request_id":"i3","operation":"inspect","root":{root:?},"unit_id":"u9"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "unknown-unit");
    let request = request_file(
        dir.path(),
        "inspect.json",
        &format!(
            r#"{{"version":1,"request_id":"i4","operation":"inspect","root":{root:?},"file":{file:?},"start":0,"end":1}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "no-unit-at-span");
}

fn assert_random_unit_id(id: &str) {
    let suffix = id.strip_prefix("g-").expect("new units use random IDs");
    assert_eq!(suffix.len(), 32, "{id}");
    assert!(
        suffix
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "{id}"
    );
}

fn positional_bound_id(stdout: &str) -> String {
    let id = stdout
        .strip_prefix("bound ")
        .expect("successful bind report")
        .split_whitespace()
        .next()
        .expect("bound unit ID");
    assert_random_unit_id(id);
    id.to_string()
}

fn bind_style(root: &str, file: &str) -> String {
    let revision = sha256_hex(APP.as_bytes());
    let (tree, _) = parse_source(SourceId(0), APP);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, APP);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let bound = dispatch(&argv(&[
        "gen",
        "bind",
        root,
        file,
        &descriptor.span.start.to_string(),
        &descriptor.span.end.to_string(),
        &revision,
        "new",
    ]));
    assert_eq!(bound.code, 0, "stderr: {}", bound.stderr);
    positional_bound_id(&bound.stdout)
}

#[test]
fn execution_ops_admit_then_stop_before_launch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    write_file(dir.path(), "can.gen.toml", SETTINGS);
    let unit_id = bind_style(&root, &file);
    // generate without a pinned recipe: admitted, handler joins BGI-05.
    let request = request_file(
        dir.path(),
        "gen.json",
        &format!(
            r#"{{"version":1,"request_id":"g1","operation":"generate","root":{root:?},"files":["app.can"],"mode":"fresh"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "not-implemented");
    assert!(message.contains("BGI-05"), "{message}");
    // generate with a pinned profile: the pre-launch gate fires first.
    let request = request_file(
        dir.path(),
        "gen.json",
        &format!(
            r#"{{"version":1,"request_id":"g2","operation":"generate","root":{root:?},"files":["app.can"],"mode":"fresh","profile":"fast"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "unsupported-capability");
    assert!(message.contains("before launch"), "{message}");
    // generate with an unknown profile diagnoses the selection.
    let request = request_file(
        dir.path(),
        "gen.json",
        &format!(
            r#"{{"version":1,"request_id":"g3","operation":"generate","root":{root:?},"files":["app.can"],"mode":"fresh","profile":"nope"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "unknown-profile");
    // generate with an incompatible override diagnoses the pair.
    let request = request_file(
        dir.path(),
        "gen.json",
        &format!(
            r#"{{"version":1,"request_id":"g4","operation":"generate","root":{root:?},"files":["app.can"],"mode":"fresh","runner":"opencode"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "runner-override-needs-model");
    // refine admits the carrier, unit, recipe, then preflights.
    let request = request_file(
        dir.path(),
        "ref.json",
        &format!(
            r#"{{"version":1,"request_id":"f1","operation":"refine","root":{root:?},"unit_id":{unit_id:?},"instruction":"darker"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "unsupported-capability");
    assert!(message.contains("MCP"), "{message}");
    // refine with an unknown unit stops at the selector.
    let request = request_file(
        dir.path(),
        "ref.json",
        &format!(
            r#"{{"version":1,"request_id":"f2","operation":"refine","root":{root:?},"unit_id":"u9","instruction":"darker"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "unknown-unit");
    // refine with an unreadable instruction file stops at the carrier.
    let request = request_file(
        dir.path(),
        "ref.json",
        &format!(
            r#"{{"version":1,"request_id":"f3","operation":"refine","root":{root:?},"unit_id":{unit_id:?},"instruction_file":"missing.txt"}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "instruction-unreadable");
    // retry with an unreadable scope stops at admission.
    let request = request_file(
        dir.path(),
        "ret.json",
        &format!(
            r#"{{"version":1,"request_id":"r1","operation":"retry","root":{root:?},"files":["missing.can"]}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2);
    assert_eq!(error_of(&result.stdout).0, "unreadable-input");
}

#[test]
fn lifecycle_ops_admit_selectors_then_name_their_join() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    let unit_id = bind_style(&root, &file);
    // Unknown units fail admission for every unit-scoped operation.
    for (operation, params) in [
        ("diff", r#""unit_id":"u9""#),
        ("preview", r#""unit_id":"u9""#),
        ("accept", r#""unit_id":"u9""#),
        ("rollback", r#""unit_id":"u9","revision":"r""#),
        ("edit.begin", r#""unit_id":"u9""#),
    ] {
        let request = request_file(
            dir.path(),
            "op.json",
            &format!(
                r#"{{"version":1,"request_id":"x","operation":"{operation}","root":{root:?},{params}}}"#
            ),
        );
        let result = dispatch(&argv(&["gen", "--request", &request]));
        assert_eq!(result.code, 2, "{operation}: {}", result.stdout);
        assert_eq!(error_of(&result.stdout).0, "unknown-unit", "{operation}");
    }
    // Admitted requests name their joining task (`validate` landed
    // with BGI-11, so it validates instead of naming a join).
    for (operation, params, join) in [
        ("diff", format!(r#""unit_id":{unit_id:?}"#), "BGI-05"),
        ("preview", format!(r#""unit_id":{unit_id:?}"#), "BGI-05"),
        (
            "adopt",
            format!(r#""unit_id":{unit_id:?},"files":["app.can"]"#),
            "BGI-12",
        ),
        ("accept", format!(r#""unit_id":{unit_id:?}"#), "BGI-12"),
        ("cancel", r#""session_id":"s1""#.to_string(), "BGI-05"),
        ("reset", r#""attempt":"a1""#.to_string(), "BGI-05"),
        (
            "rollback",
            format!(r#""unit_id":{unit_id:?},"revision":"r""#),
            "BGI-12",
        ),
        ("resume", r#""session_id":"s1""#.to_string(), "BGI-05"),
        ("edit.begin", format!(r#""unit_id":{unit_id:?}"#), "BGI-04"),
        ("edit.end", r#""token":"t""#.to_string(), "BGI-04"),
        ("lease.recover", r#""lease":"l""#.to_string(), "BGI-04"),
    ] {
        let request = request_file(
            dir.path(),
            "op.json",
            &format!(
                r#"{{"version":1,"request_id":"x","operation":"{operation}","root":{root:?},{params}}}"#
            ),
        );
        let result = dispatch(&argv(&["gen", "--request", &request]));
        assert_eq!(result.code, 2, "{operation}: {}", result.stdout);
        let (code, message) = error_of(&result.stdout);
        assert_eq!(code, "not-implemented", "{operation}");
        assert!(message.contains(join), "{operation}: {message}");
    }
    // The landed `validate` join checks its scope instead of naming
    // BGI-11: the fresh bound style unit has no saved CSS yet, and a
    // `.can` source is not a saved output file.
    let request = request_file(
        dir.path(),
        "op.json",
        &format!(
            r#"{{"version":1,"request_id":"x","operation":"validate","root":{root:?},"unit_id":{unit_id:?}}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains("style.css"), "{message}");
    // Relative scope files resolve at the request root.
    let request = request_file(
        dir.path(),
        "op.json",
        &format!(
            r#"{{"version":1,"request_id":"x","operation":"validate","root":{root:?},"files":["app.can"]}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains("not a saved output file"), "{message}");
}

#[test]
fn request_routing_flags_and_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    // Missing --request files answer with the envelope, not a bare error.
    let result = dispatch(&argv(&["gen", "--request", "missing.json"]));
    assert_eq!(result.code, 2);
    let (code, _) = error_of(&result.stdout);
    assert_eq!(code, "request-unreadable");
    let _ = root;
    // --request takes no operands.
    let request = request_file(
        dir.path(),
        "doctor.json",
        r#"{"version":1,"request_id":"d","operation":"doctor"}"#,
    );
    let result = dispatch(&argv(&["gen", "--request", &request, "status"]));
    assert_eq!(result.code, 2);
    assert!(
        result.stderr.contains("--request FILE takes no operands"),
        "{}",
        result.stderr
    );
    // --format does not apply to the envelope dispatcher.
    let result = dispatch(&argv(&["gen", "--format=json", "--request", &request]));
    assert_eq!(result.code, 2);
    assert!(
        result.stderr.contains("--format does not apply"),
        "{}",
        result.stderr
    );
    // --request belongs to gen only.
    let result = dispatch(&argv(&["check", "--request", &request, "app.can"]));
    assert_eq!(result.code, 2);
    assert!(
        result.stderr.contains("--request only applies to can gen"),
        "{}",
        result.stderr
    );
    // Positional unknown operations still diagnose with a JSON pointer.
    let result = dispatch(&argv(&["gen", "retry", "root", "app.can"]));
    assert_eq!(result.code, 2);
    assert!(result.stderr.contains("BGI-03"), "{}", result.stderr);
    assert!(result.stderr.contains("--request"), "{}", result.stderr);
}

#[test]
fn envelope_and_event_shapes() {
    let header = canlang_compiler::analysis::generation_protocol::RequestHeader {
        request_id: "r42".to_string(),
        operation: canlang_compiler::analysis::generation_protocol::GenOperation::Refine,
    };
    let mut payload = serde_json::Map::new();
    payload.insert("state_note".to_string(), serde_json::json!("candidate"));
    let ok = ok_envelope(&header, "candidate", payload, vec!["next-a".to_string()]);
    let body: serde_json::Value = serde_json::from_str(&ok).unwrap();
    assert_eq!(body["version"], 1);
    assert_eq!(body["request_id"], "r42");
    assert_eq!(body["operation"], "refine");
    assert_eq!(body["ok"], true);
    assert_eq!(body["state"], "candidate");
    assert_eq!(body["next"], serde_json::json!(["next-a"]));
    let failed = error_envelope("r42", "refine", "stale-selector", "stale", vec![]);
    let body: serde_json::Value = serde_json::from_str(&failed).unwrap();
    assert_eq!(body["ok"], false);
    assert_eq!(body["state"], "error");
    assert_eq!(body["error"]["code"], "stale-selector");
    assert_eq!(body["next"], serde_json::json!([]));
    let event = progress_event("r42", "refine", "capture", "reading sources");
    let body: serde_json::Value = serde_json::from_str(&event).unwrap();
    assert_eq!(body["version"], 1);
    assert_eq!(body["event"], "progress");
    assert_eq!(body["phase"], "capture");
}

#[test]
fn bound_copies_both_usable_through_status() {
    // BGI02-repair join (can-bg-56271b11-codex-leases-20261013T064639Z):
    // status routes through associate_with_source with current
    // file/revision evidence, so two explicitly bound copies are both
    // usable through the public CLI while current edited bytes stay
    // intact. Without the join, the duplicate key reports ambiguous.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let source = "app DupApp\nGiven\n Todo {title:text}\nWhen\n scenario complete(task:Todo) by=members\n  do set task {title=\"Done\"}\nThen\n## Two identical definitions share one association key.\n style Dup $\"Same look.\"\n style Dup $\"Same look.\"\n";
    let file = write_file(dir.path(), "dup.can", source);
    let revision = sha256_hex(source.as_bytes());
    let (tree, diags) = parse_source(SourceId(0), source);
    assert!(diags.is_empty(), "{diags:?}");
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, source);
    let styles: Vec<_> = found
        .descriptors
        .iter()
        .filter(|d| d.kind == GenerationKind::StyleDefinition)
        .collect();
    assert_eq!(styles.len(), 2);
    // Bind the original, then the second location as new.
    let mut unit_ids = Vec::new();
    for descriptor in &styles {
        let bound = dispatch(&argv(&[
            "gen",
            "bind",
            &root,
            &file,
            &descriptor.span.start.to_string(),
            &descriptor.span.end.to_string(),
            &revision,
            "new",
        ]));
        assert_eq!(bound.code, 0, "stderr: {}", bound.stderr);
        unit_ids.push(positional_bound_id(&bound.stdout));
    }
    assert_ne!(unit_ids[0], unit_ids[1], "copies own independent groups");
    // Current user-edited bytes under both groups.
    let edited_u1 = "/* user-edited u1 */\n.a{color:red}\n";
    let edited_u2 = "/* user-edited u2 */\n.a{color:blue}\n";
    std::fs::write(
        dir.path()
            .join(GENERATED_DIR)
            .join(&unit_ids[0])
            .join("style.css"),
        edited_u1,
    )
    .unwrap();
    std::fs::write(
        dir.path()
            .join(GENERATED_DIR)
            .join(&unit_ids[1])
            .join("style.css"),
        edited_u2,
    )
    .unwrap();
    // Status honors both explicit binds and preserves the edits.
    let status = dispatch(&argv(&["gen", "status", "--format=json", &root, &file]));
    assert_eq!(status.code, 0, "stderr: {}", status.stderr);
    let report: serde_json::Value = serde_json::from_str(&status.stdout).unwrap();
    let units = report["units"].as_array().unwrap();
    assert_eq!(units.len(), 2, "{units:?}");
    for (index, unit) in units.iter().enumerate() {
        assert_eq!(unit["association"], "retained", "{unit:?}");
        assert_eq!(unit["id"], unit_ids[index], "{unit:?}");
    }
    assert_eq!(report["issues"], serde_json::json!([]), "{report:?}");
    assert_eq!(
        std::fs::read_to_string(
            dir.path()
                .join(GENERATED_DIR)
                .join(&unit_ids[0])
                .join("style.css")
        )
        .unwrap(),
        edited_u1
    );
    assert_eq!(
        std::fs::read_to_string(
            dir.path()
                .join(GENERATED_DIR)
                .join(&unit_ids[1])
                .join("style.css")
        )
        .unwrap(),
        edited_u2
    );
}

fn run_binary(args: &[&str], stdin_text: Option<&str>) -> std::process::Output {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new(env!("CARGO_BIN_EXE_can"))
        // These are compiler-owner admission checks; public requests use Node.
        .env("CAN_GENERATION_COMPILER_ONLY", "1")
        .args(args)
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn can");
    if let Some(text) = stdin_text {
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(text.as_bytes())
            .expect("write stdin");
    }
    child.wait_with_output().expect("wait for can")
}

#[test]
fn stdin_request_round_trip_through_the_binary() {
    // Bare `can gen` reads the request from stdin.
    let output = run_binary(
        &["gen"],
        Some(r#"{"version":1,"request_id":"std1","operation":"doctor"}"#),
    );
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let body = envelope(&stdout);
    assert_eq!(body["operation"], "doctor");
    assert_eq!(body["request_id"], "std1");
    // instruction_stdin with a stdin request refuses: one stream
    // cannot carry both.
    let output = run_binary(
        &["gen"],
        Some(
            r#"{"version":1,"request_id":"std2","operation":"refine","root":".","unit_id":"u1","instruction_stdin":true}"#,
        ),
    );
    assert_eq!(output.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert_eq!(error_of(&stdout).0, "exclusive-carrier");
}

#[test]
fn request_file_with_stdin_instruction_through_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    let unit_id = bind_style(&root, &file);
    // --request FILE plus a piped instruction passes carrier
    // admission (the unknown unit then fails, proving the order).
    let request = request_file(
        dir.path(),
        "ref.json",
        &format!(
            r#"{{"version":1,"request_id":"std3","operation":"refine","root":{root:?},"unit_id":"u9","instruction_stdin":true}}"#
        ),
    );
    let output = run_binary(&["gen", "--request", &request], Some("darker, please"));
    assert_eq!(output.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert_eq!(error_of(&stdout).0, "unknown-unit");
    // An empty piped instruction refuses.
    let request = request_file(
        dir.path(),
        "ref.json",
        &format!(
            r#"{{"version":1,"request_id":"std4","operation":"refine","root":{root:?},"unit_id":{unit_id:?},"instruction_stdin":true}}"#
        ),
    );
    let output = run_binary(&["gen", "--request", &request], Some(""));
    assert_eq!(output.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert_eq!(error_of(&stdout).0, "invalid-param");
}

/// Owning declaration with an explicit `agent=frontend` selection.
const FRONTEND_AGENT: &str = r#"app Front
Given
 Item {a:text}
When
Then
 style Surface agent=frontend $"Readable"
 page / title="T"
  text "hello"
"#;

#[test]
fn explicit_frontend_agent_without_profile_diagnoses() {
    // Shared recipe only: no `frontend` profile is configured.
    let plain = loaded_settings("version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"m\"\n");
    // An explicit owning-declaration `agent=frontend` names a
    // profile that must exist, so it diagnoses.
    let err = resolve_recipe(
        Some(&plain),
        RecipeCategory::Frontend,
        Some("frontend"),
        &RunOverrides::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "unknown-profile");
    assert!(err.to_string().contains("frontend"), "{err}");
    // An explicit run profile selection diagnoses the same way.
    let err = resolve_recipe(
        Some(&plain),
        RecipeCategory::Frontend,
        None,
        &RunOverrides {
            profile: Some("frontend".to_string()),
            ..RunOverrides::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code(), "unknown-profile");
    // The implicit Then default still falls back to shared.
    let resolved = resolve_recipe(
        Some(&plain),
        RecipeCategory::Frontend,
        None,
        &RunOverrides::default(),
    )
    .unwrap();
    assert_eq!(resolved.runner, "codex");
    assert!(
        resolved.origins["runner"].starts_with("shared recipe"),
        "{}",
        resolved.origins["runner"]
    );
    // End to end: spanned inspect of the explicit declaration
    // diagnoses, while an agentless Then unit falls back.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "front.can", FRONTEND_AGENT);
    write_file(
        dir.path(),
        "can.gen.toml",
        "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"fixture\"\n",
    );
    let (tree, _) = parse_source(SourceId(0), FRONTEND_AGENT);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, FRONTEND_AGENT);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let request = request_file(
        dir.path(),
        "inspect.json",
        &format!(
            r#"{{"version":1,"request_id":"f1","operation":"inspect","root":{root:?},"file":{file:?},"start":{},"end":{}}}"#,
            descriptor.span.start, descriptor.span.end,
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert!(body["recipe"].is_null(), "{}", body["recipe"]);
    assert_eq!(body["recipe_error"]["code"], "unknown-profile");
    assert!(
        body["recipe_error"]["message"]
            .as_str()
            .unwrap()
            .contains("frontend"),
        "{}",
        body["recipe_error"]
    );
    let plain_file = write_file(dir.path(), "app.can", APP);
    let (tree, _) = parse_source(SourceId(0), APP);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, APP);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let request = request_file(
        dir.path(),
        "inspect.json",
        &format!(
            r#"{{"version":1,"request_id":"f2","operation":"inspect","root":{root:?},"file":{plain_file:?},"start":{},"end":{}}}"#,
            descriptor.span.start, descriptor.span.end,
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["recipe"]["model"], "fixture");
    assert!(
        body["recipe"]["origins"]["model"]
            .as_str()
            .unwrap()
            .starts_with("shared recipe"),
        "{}",
        body["recipe"]
    );
}

#[test]
fn zero_run_limits_refuse_before_recipe() {
    // Admission refuses zero on every recipe-bearing operation.
    for operation in ["doctor", "inspect", "generate", "refine", "retry"] {
        let body = match operation {
            "doctor" => r#"{"version":1,"request_id":"z","operation":"doctor","max_attempts":0,"timeout_seconds":0}"#.to_string(),
            "inspect" => r#"{"version":1,"request_id":"z","operation":"inspect","root":".","unit_id":"u1","max_attempts":0}"#.to_string(),
            "generate" => r#"{"version":1,"request_id":"z","operation":"generate","root":".","files":["a.can"],"mode":"fresh","timeout_seconds":0}"#.to_string(),
            "refine" => r#"{"version":1,"request_id":"z","operation":"refine","root":".","unit_id":"u1","instruction":"x","max_attempts":0}"#.to_string(),
            _ => r#"{"version":1,"request_id":"z","operation":"retry","root":".","files":["a.can"],"timeout_seconds":0}"#.to_string(),
        };
        let err = parse_request(&body).unwrap_err();
        assert_eq!(err.code, "invalid-param", "{operation}");
        assert_eq!(err.exit, 2, "{operation}");
    }
    // Recipe construction refuses zero overrides the same way TOML
    // refuses nonpositive limits.
    let loaded = loaded_settings(SETTINGS);
    for overrides in [
        RunOverrides {
            max_attempts: Some(0),
            ..RunOverrides::default()
        },
        RunOverrides {
            timeout_seconds: Some(0),
            ..RunOverrides::default()
        },
    ] {
        let err =
            resolve_recipe(Some(&loaded), RecipeCategory::Given, None, &overrides).unwrap_err();
        assert_eq!(err.code(), "invalid-settings", "{overrides:?}");
        assert!(err.to_string().contains("positive finite integer"), "{err}");
    }
    // Explicit finite positive overrides still resolve.
    let resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Given,
        None,
        &RunOverrides {
            max_attempts: Some(3),
            timeout_seconds: Some(45),
            ..RunOverrides::default()
        },
    )
    .unwrap();
    assert_eq!(resolved.max_attempts, 3);
    assert_eq!(resolved.timeout_seconds, 45);
    assert_eq!(resolved.origins["max_attempts"], "run override");
    assert_eq!(resolved.origins["timeout_seconds"], "run override");
    // End to end: doctor refuses before reporting any recipe, and a
    // pinned generate refuses before the launch path.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    write_file(dir.path(), "app.can", APP);
    write_file(dir.path(), "can.gen.toml", SETTINGS);
    let request = request_file(
        dir.path(),
        "doctor.json",
        &format!(
            r#"{{"version":1,"request_id":"z1","operation":"doctor","root":{root:?},"max_attempts":0,"timeout_seconds":0}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2, "stdout: {}", result.stdout);
    assert_eq!(error_of(&result.stdout).0, "invalid-param");
    let request = request_file(
        dir.path(),
        "gen.json",
        &format!(
            r#"{{"version":1,"request_id":"z2","operation":"generate","root":{root:?},"files":["app.can"],"mode":"fresh","profile":"fast","max_attempts":0}}"#
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 2, "stdout: {}", result.stdout);
    assert_eq!(error_of(&result.stdout).0, "invalid-param");
}

#[test]
fn spanned_inspect_resolves_current_profile() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    write_file(
        dir.path(),
        "can.gen.toml",
        "version = 1\n[generation]\nrunner = \"codex\"\nmodel = \"shared-model\"\n[generation.profiles.slow]\nrunner = \"codex\"\nmodel = \"slow-model\"\n[generation.profiles.fast]\nrunner = \"codex\"\nmodel = \"fast-model\"\n",
    );
    let old = FRONTEND_AGENT.replace("agent=frontend", "agent=slow");
    let file = write_file(dir.path(), "front.can", &old);
    let revision = sha256_hex(old.as_bytes());
    let (tree, _) = parse_source(SourceId(0), &old);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, &old);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let bound = dispatch(&argv(&[
        "gen",
        "bind",
        &root,
        &file,
        &descriptor.span.start.to_string(),
        &descriptor.span.end.to_string(),
        &revision,
        "new",
    ]));
    assert_eq!(bound.code, 0, "stderr: {}", bound.stderr);
    let unit_id = positional_bound_id(&bound.stdout);
    // Edit only the owning declaration's agent.
    let new = old.replace("agent=slow", "agent=fast");
    std::fs::write(&file, &new).unwrap();
    let (tree, _) = parse_source(SourceId(0), &new);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, &new);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleDefinition)
        .unwrap();
    let request = request_file(
        dir.path(),
        "inspect.json",
        &format!(
            r#"{{"version":1,"request_id":"c1","operation":"inspect","root":{root:?},"file":{file:?},"start":{},"end":{}}}"#,
            descriptor.span.start, descriptor.span.end,
        ),
    );
    let result = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    // Identity is retained, but the recipe resolves the current
    // source profile for future attempts.
    assert_eq!(body["unit"]["id"], unit_id);
    assert_eq!(body["unit"]["association"], "retained");
    assert_eq!(body["unit"]["prompt_changed"], false);
    assert_eq!(body["recipe"]["model"], "fast-model");
    assert!(
        body["recipe"]["recipe_source"]
            .as_str()
            .unwrap()
            .starts_with("profile 'fast'"),
        "{}",
        body["recipe"]
    );
    // The reported contract keeps the saved original as history.
    assert_eq!(body["unit"]["contract"]["profile"], "slow");
    // The historical receipt is untouched: no rewrite, no forced
    // adoption of compatible current output.
    let receipt = std::fs::read_to_string(
        dir.path()
            .join(GENERATED_DIR)
            .join(&unit_id)
            .join(UNIT_FILE),
    )
    .unwrap();
    let saved: serde_json::Value = serde_json::from_str(&receipt).unwrap();
    assert_eq!(saved["contract"]["profile"], "slow");
}

#[test]
fn codex_native_reasoning_validates_explicit_effort_before_capabilities() {
    let loaded = loaded_settings(SETTINGS);
    let mut resolved = resolve_recipe(
        Some(&loaded),
        RecipeCategory::Given,
        None,
        &RunOverrides::default(),
    )
    .unwrap();
    resolved.runner = "codex".into();
    resolved.model = "gpt-6.1-sol".into();
    for value in [
        serde_json::json!(true),
        serde_json::json!(2),
        serde_json::json!("turbo"),
        serde_json::json!(""),
    ] {
        resolved.native = BTreeMap::from([("model_reasoning_effort".into(), value)]);
        assert_eq!(
            preflight_recipe(&resolved).unwrap_err().code(),
            "invalid-native-option"
        );
    }
    for value in ["low", "medium", "high", "xhigh", "max", "ultra"] {
        resolved.native =
            BTreeMap::from([("model_reasoning_effort".into(), serde_json::json!(value))]);
        assert!(preflight_recipe(&resolved).is_ok());
    }
}
