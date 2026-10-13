//! BGI-11: target validation, maps and zero-AI saved build.
//!
//! Covers the `can gen validate` dispatch by kind/target (keyword,
//! trait, style, view), missing/incompatible input diagnosis,
//! source/interface drift routing to deterministic manual adoption,
//! saved-JS maps with Can owner links, checked closure packing, and
//! saved-build determinism from a clean checkout with zero AI/MCP
//! processes. Consumes only the selected unit kind's producer outputs
//! (BGI-07 contracts, BGI-09 lowering, BGI-10 scoping); the
//! workerd/browser actual-target gate stays explicitly open and is
//! reported, never claimed.

use canlang_compiler::analysis::generation::GenerationKind;
use canlang_compiler::cli::dispatch;
use canlang_compiler::source::{SourceId, sha256_hex};
use canlang_compiler::syntax::parse_source;

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

/// Bind one identity-carrying descriptor in `text` to a fresh unit id.
/// Returns the allocated id (`u1`, `u2`, ... in bind order).
fn bind_new(
    root: &str,
    file: &str,
    text: &str,
    kind: GenerationKind,
    label: Option<&str>,
) -> String {
    let revision = sha256_hex(text.as_bytes());
    let (tree, _) = parse_source(SourceId(0), text);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, text);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == kind && label.map(|l| d.label.as_deref() == Some(l)).unwrap_or(true))
        .unwrap_or_else(|| panic!("no {kind:?} descriptor for {label:?}"));
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
    // `bound u1 <file:start..end> -> <unit.json>`.
    bound.stdout.split_whitespace().nth(1).unwrap().to_string()
}

fn validate_unit(
    root: &str,
    dir: &std::path::Path,
    name: &str,
    unit: &str,
) -> canlang_compiler::cli::DispatchResult {
    let request = request_file(
        dir,
        name,
        &format!(
            r#"{{"version":1,"request_id":"v1","operation":"validate","root":{root:?},"unit_id":{unit:?}}}"#
        ),
    );
    dispatch(&argv(&["gen", "--request", &request]))
}

fn validate_files(
    root: &str,
    dir: &std::path::Path,
    name: &str,
    files: &[&str],
) -> canlang_compiler::cli::DispatchResult {
    let files_json = files
        .iter()
        .map(|f| format!("{f:?}"))
        .collect::<Vec<_>>()
        .join(",");
    let request = request_file(
        dir,
        name,
        &format!(
            r#"{{"version":1,"request_id":"v1","operation":"validate","root":{root:?},"files":[{files_json}]}}"#
        ),
    );
    dispatch(&argv(&["gen", "--request", &request]))
}

fn patch_unit_json(root: &str, unit: &str, patch: impl FnOnce(&mut serde_json::Value)) {
    let path = std::path::Path::new(root)
        .join("can.generated")
        .join(unit)
        .join("unit.json");
    let text = std::fs::read_to_string(&path).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    patch(&mut value);
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
}

/// Given fixture: named trait reuse plus the novel standalone keyword.
/// `##` comments are ordinary documentation: they never affect
/// discovery, association, or validation.
const GIVEN_APP: &str = r#"app Tasks
## A reusable model trait: every application shares one saved template.
Given
 trait completable $"Add done:bool=false with Open/Done labels."
 ## The novel standalone keyword: canonical identity is unavailable in current Can.
 keyword canonical_identity(target:model,field:field(target,text)) $"Use the field's NFKC-normalized, ASCII-lowercased text as a canonical unique key, preserving its stored spelling and normal permissions."
 Todo {title:text trim min=1 max=200} completable
 ## A one-off inline attachment owns its own unit, separate from the named trait.
 Note {body:text} trait $"Add pinned:bool=false."
 Account {handle:text}
 canonical_identity target=Account field=Account.handle
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
 page / title="Todos"
  text "hi"
"#;

const TRAIT_CARRIER: &str = r#"app Tasks
## Template for the `completable` trait: one template, every application.
Given
 completable {done:bool=false}
"#;

const KEYWORD_JS: &str = r#"export function canonicalKey(value) { return value.normalize("NFKC").toLowerCase(); }
"#;

const KEYWORD_DECLARATION: &str = r#"{"producer":"state.unique-key@1","export":"canonicalKey","reads":[],"effects":[],"authority":[]}"#;

/// Then fixture: named style, prompted row-bound view, and style uses.
const THEN_APP: &str = r#"app Tasks
Given
 trait completable $"Add done:bool=false."
 Todo {title:text trim min=1 max=200} completable
 keyword canonical_identity(target:model, field:field(target,text)) $"Use NFKC keys."
 Account {handle:text}
 canonical_identity target=Account field=Account.handle
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
 style TaskSurface $"Readable task surfaces."
 view TaskTile(row:Todo) $"Arrange admitted title/status and declared controls."
  edit fields=title
  delete
  style TaskSurface
 page / title="Todos" $"A calm workspace."
  card "Add a task" $"A compact entry area."
   form Todo.create fields=title
    input title $TaskSurface
  list Todo as task $TaskSurface
   show TaskTile {row=row} $TaskSurface
"#;

const STYLE_CSS: &str = ".tile { color: red; }\n";

const VIEW_JS: &str = r#"export function render({row, bindings, ui}) { return null; }
export function mount(root, presentation) { return () => {}; }
"#;

// ## Validator dispatch per kind.

#[test]
fn keyword_unit_validates_for_workerd() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    // No generation settings anywhere: the saved build needs none.
    assert!(!dir.path().join("can.gen.toml").exists());
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    assert!(result.stderr.is_empty(), "stderr: {}", result.stderr);
    let body = envelope(&result.stdout);
    assert_eq!(body["ok"], true);
    assert_eq!(body["state"], "validated");
    assert_eq!(body["unit_id"], unit);
    assert_eq!(body["kind"], "keyword");
    assert_eq!(body["runtime_targets"], serde_json::json!(["workerd"]));
    let checks = body["checks"].as_array().unwrap();
    let names: Vec<&str> = checks.iter().map(|c| c["name"].as_str().unwrap()).collect();
    for name in [
        "source",
        "declaration",
        "contract",
        "contract-binding",
        "exports",
        "imports",
        "fingerprint",
    ] {
        assert!(names.contains(&name), "{names:?}");
    }
    assert!(checks.iter().all(|c| c["ok"] == true));
    // Validation binds to captured inputs and current bytes: the exact
    // consumed closure is in the envelope for promotion comparison.
    assert_eq!(body["inputs"]["source"]["path"], serde_json::json!(file));
    assert_eq!(
        body["inputs"]["source"]["revision"],
        serde_json::json!(sha256_hex(GIVEN_APP.as_bytes()))
    );
    let bound: Vec<(&str, &str)> = body["inputs"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap(), f["sha256"].as_str().unwrap()))
        .collect();
    let js_sha = sha256_hex(KEYWORD_JS.as_bytes());
    assert_eq!(body["fingerprint"], serde_json::json!(js_sha));
    // Every bound entry hashes the exact current bytes on disk: the
    // envelope consumes nothing else and reports nothing stale.
    for (path, hash) in &bound {
        let bytes = std::fs::read(dir.path().join(path)).unwrap();
        assert_eq!(&sha256_hex(&bytes), hash, "{path}");
    }
    let paths: Vec<&&str> = bound.iter().map(|(p, _)| p).collect();
    assert!(paths.contains(&&file.as_str()), "{paths:?}");
    assert!(paths.iter().any(|p| p.ends_with("/unit.json")), "{paths:?}");
    assert!(
        bound
            .iter()
            .any(|(p, h)| p.ends_with("/implementation.js") && h == &js_sha),
        "{bound:?}"
    );
    assert!(
        paths.iter().any(|p| p.ends_with("/declaration.json")),
        "{paths:?}"
    );
    assert_eq!(body["modified_since_generation"], false);
    assert_eq!(body["prompt_changed"], false);
}

#[test]
fn trait_unit_validates_through_checked_contributions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::NamedTrait,
        Some("completable"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/contributions.can"),
        TRAIT_CARRIER,
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["state"], "validated");
    assert_eq!(body["kind"], "named-trait");
    assert_eq!(body["runtime_targets"], serde_json::json!(["check"]));
    let names: Vec<&str> = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    for name in ["source", "contract", "contributions", "fingerprint"] {
        assert!(names.contains(&name), "{names:?}");
    }
    assert_eq!(
        body["fingerprint"],
        serde_json::json!(sha256_hex(TRAIT_CARRIER.as_bytes()))
    );
}

#[test]
fn trait_unit_with_saved_js_refuses() {
    // BGI-07 admits no saved JavaScript for trait units in v1; the
    // validator passes the stray module through to that refusal.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::NamedTrait,
        Some("completable"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/contributions.can"),
        TRAIT_CARRIER,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "export function hook() {}\n",
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains("E4056"), "{message}");
    assert!(message.contains(&unit), "{message}");
}

#[test]
fn style_unit_validates_and_owned_assets_resolve() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", THEN_APP);
    let unit = bind_new(
        &root,
        &file,
        THEN_APP,
        GenerationKind::StyleDefinition,
        Some("TaskSurface"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/style.css"),
        STYLE_CSS,
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["kind"], "style");
    assert_eq!(body["runtime_targets"], serde_json::json!(["css"]));
    // An owned asset URL resolves to a saved unit file.
    let with_asset = ".tile { background: url(assets/bg.png); }\n";
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/style.css"),
        with_asset,
    );
    let missing = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(missing.code, 4, "stdout: {}", missing.stdout);
    let (code, message) = error_of(&missing.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains("assets/bg.png"), "{message}");
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/assets/bg.png"),
        "fake-png-bytes",
    );
    let present = validate_unit(&root, dir.path(), "v3.json", &unit);
    assert_eq!(present.code, 0, "stdout: {}", present.stdout);
    let body = envelope(&present.stdout);
    let names: Vec<&str> = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"assets"), "{names:?}");
}

#[test]
fn style_scope_errors_diagnose() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", THEN_APP);
    let unit = bind_new(
        &root,
        &file,
        THEN_APP,
        GenerationKind::StyleDefinition,
        Some("TaskSurface"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/style.css"),
        "body { margin: 0; }\n",
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains("E2103"), "{message}");
    assert!(message.contains(&unit), "{message}");
}

#[test]
fn view_unit_validates_render_and_mount_for_both_targets() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", THEN_APP);
    let unit = bind_new(
        &root,
        &file,
        THEN_APP,
        GenerationKind::ViewDefinition,
        Some("TaskTile"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        VIEW_JS,
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["kind"], "view");
    assert_eq!(
        body["runtime_targets"],
        serde_json::json!(["workerd", "browser"])
    );
    let names: Vec<&str> = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    for name in ["source", "lowering", "exports", "imports", "fingerprint"] {
        assert!(names.contains(&name), "{names:?}");
    }
    // Server render without a browser mount still validates.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "export function render({row, bindings, ui}) { return null; }\n",
    );
    let render_only = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(render_only.code, 0, "stdout: {}", render_only.stdout);
    // No `render` export refuses with the exact unit.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "export function mount(root, presentation) { return () => {}; }\n",
    );
    let missing = validate_unit(&root, dir.path(), "v3.json", &unit);
    assert_eq!(missing.code, 4, "stdout: {}", missing.stdout);
    let (code, message) = error_of(&missing.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains(&unit), "{message}");
    assert!(message.contains("render"), "{message}");
}

// ## Missing/incompatible inputs diagnose.

#[test]
fn unknown_unit_is_an_exit_2_selection_error() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    write_file(dir.path(), "app.can", GIVEN_APP);
    let result = validate_unit(&root, dir.path(), "v.json", "u9");
    assert_eq!(result.code, 2, "stdout: {}", result.stdout);
    assert_eq!(error_of(&result.stdout).0, "unknown-unit");
}

#[test]
fn missing_primary_output_reports_generate() {
    // A fresh bound unit with no saved outputs cannot validate: the
    // envelope names the unit, the missing file, and the action.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", THEN_APP);
    let unit = bind_new(
        &root,
        &file,
        THEN_APP,
        GenerationKind::StyleDefinition,
        Some("TaskSurface"),
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains(&unit), "{message}");
    assert!(message.contains("style.css"), "{message}");
    let body = envelope(&result.stdout);
    let next = body["next"].as_array().unwrap();
    assert!(
        next.iter()
            .any(|n| n.as_str().unwrap().contains("generate")),
        "{next:?}"
    );
}

#[test]
fn missing_export_names_unit_and_export() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    // Quoted and commented tokens never certify an export.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "// export function canonicalKey(value) {}\nconst s = \"export function canonicalKey\";\nexport function other() {}\n",
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains(&unit), "{message}");
    assert!(message.contains("canonicalKey"), "{message}");
}

#[test]
fn missing_declaration_and_strict_shape_diagnose() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    // No declaration sidecar.
    let missing = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(missing.code, 4, "stdout: {}", missing.stdout);
    let (_, message) = error_of(&missing.stdout);
    assert!(message.contains("declaration.json"), "{message}");
    // Unknown fields refuse: validation never checks stale metadata.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        r#"{"producer":"state.unique-key@1","export":"canonicalKey","model":"sneaky"}"#,
    );
    let strict = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(strict.code, 4, "stdout: {}", strict.stdout);
    // Empty export refuses.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        r#"{"producer":"state.unique-key@1","export":""}"#,
    );
    let empty = validate_unit(&root, dir.path(), "v3.json", &unit);
    assert_eq!(empty.code, 4, "stdout: {}", empty.stdout);
    // Unknown producers refuse through the BGI-07 producer check.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        r#"{"producer":"state.evil@9","export":"canonicalKey"}"#,
    );
    let producer = validate_unit(&root, dir.path(), "v4.json", &unit);
    assert_eq!(producer.code, 4, "stdout: {}", producer.stdout);
    let (_, message) = error_of(&producer.stdout);
    assert!(message.contains("E3023"), "{message}");
}

#[test]
fn declaration_on_non_keyword_unit_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", THEN_APP);
    let unit = bind_new(
        &root,
        &file,
        THEN_APP,
        GenerationKind::StyleDefinition,
        Some("TaskSurface"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/style.css"),
        STYLE_CSS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (_, message) = error_of(&result.stdout);
    assert!(message.contains("declaration.json"), "{message}");
}

// ## Workerd/browser separation: privileged imports never validate.

#[test]
fn privileged_and_bare_imports_refuse_unit_local_relative_passes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    let js_path = format!("can.generated/{unit}/implementation.js");
    // Source/process/filesystem APIs, bare specifiers, CommonJS, and
    // non-literal edges all refuse with the exact unit and specifier.
    for (js, needle) in [
        (
            "import fs from \"fs\";\nexport function canonicalKey(v) { return v; }\n",
            "`fs`",
        ),
        (
            "import {x} from \"node:fs\";\nexport function canonicalKey(v) { return v; }\n",
            "`node:fs`",
        ),
        (
            "export function canonicalKey(v) { return import(\"process\"); }\n",
            "`process`",
        ),
        (
            "const p = require(\"node:process\");\nexport function canonicalKey(v) { return v; }\n",
            "require",
        ),
        (
            "import x from \"left-pad\";\nexport function canonicalKey(v) { return v; }\n",
            "`left-pad`",
        ),
        (
            "export {a} from \"node:path\";\nexport function canonicalKey(v) { return v; }\n",
            "`node:path`",
        ),
        (
            "export function canonicalKey(v, name) { return import(name); }\n",
            "non-literal dynamic import",
        ),
        (
            "import \"file:///etc/passwd\";\nexport function canonicalKey(v) { return v; }\n",
            "`file:///etc/passwd`",
        ),
    ] {
        write_file(dir.path(), &js_path, js);
        let result = validate_unit(&root, dir.path(), "v.json", &unit);
        assert_eq!(result.code, 4, "{js:?}: {}", result.stdout);
        let (code, message) = error_of(&result.stdout);
        assert_eq!(code, "validation-failure", "{js:?}");
        assert!(message.contains(&unit), "{js:?}: {message}");
        assert!(message.contains(needle), "{js:?}: {message}");
    }
    // Unit-local relative imports (static, multiline, dynamic, and
    // side-effect) validate; `import.meta` is not an edge.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/helper.js"),
        "export function help(v) { return v; }\n",
    );
    write_file(
        dir.path(),
        &js_path,
        "import {help} from \"./helper.js\";\nimport {\n  help as help2,\n} from \"./helper.js\";\nimport \"./helper.js\";\nexport function canonicalKey(v) { return import.meta.url && help(v); }\n",
    );
    let relative = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(relative.code, 0, "stdout: {}", relative.stdout);
    let body = envelope(&relative.stdout);
    let imports = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "imports")
        .unwrap();
    assert!(
        imports["detail"].as_str().unwrap().contains('3'),
        "{imports}"
    );
}

// ## Source/interface drift routes to deterministic manual adoption.

#[test]
fn structural_and_signature_drift_route_to_adopt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    // Structural drift: the definition is gone from the current source.
    let drifted = GIVEN_APP.replace(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Use the field's NFKC-normalized, ASCII-lowercased text as a canonical unique key, preserving its stored spelling and normal permissions.\"\n",
        "",
    );
    assert_ne!(drifted, GIVEN_APP);
    std::fs::write(&file, &drifted).unwrap();
    let missing = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(missing.code, 4, "stdout: {}", missing.stdout);
    let (_, message) = error_of(&missing.stdout);
    assert!(message.contains("drifted"), "{message}");
    assert!(message.contains(&unit), "{message}");
    let next = envelope(&missing.stdout)["next"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(next.iter().any(|n| n.contains("adopt")), "{next:?}");
    // The saved group is preserved untouched by the refused validation.
    assert_eq!(
        std::fs::read_to_string(
            dir.path()
                .join(format!("can.generated/{unit}/implementation.js"))
        )
        .unwrap(),
        KEYWORD_JS
    );
    // Signature drift: the anchor still matches, the contract changed.
    let resigned = GIVEN_APP.replace(
        "keyword canonical_identity(target:model,field:field(target,text))",
        "keyword canonical_identity(target:model,field:field(target,text),mode:text)",
    );
    std::fs::write(&file, &resigned).unwrap();
    let signature = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(signature.code, 4, "stdout: {}", signature.stdout);
    let (_, message) = error_of(&signature.stdout);
    assert!(message.contains("signature"), "{message}");
}

#[test]
fn prompt_only_change_validates_with_freshness_note() {
    // Compatible code stays buildable across a prompt-only edit: the
    // unit validates and the envelope reports the freshness change.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    let edited = GIVEN_APP.replace("normal permissions.", "normal permissions, quickly.");
    std::fs::write(&file, &edited).unwrap();
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    assert_eq!(envelope(&result.stdout)["prompt_changed"], true);
}

#[test]
fn recorded_target_mismatch_is_interface_drift() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    patch_unit_json(&root, &unit, |value| {
        value["contract"]["target"] = serde_json::json!("browser");
    });
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (_, message) = error_of(&result.stdout);
    assert!(message.contains("drifted"), "{message}");
}

#[test]
fn direct_edits_report_modified_provenance_and_still_validate() {
    // Truthful provenance: current bytes differing from recorded
    // originals validate and report `modified_since_generation`,
    // without crediting the edit to the original generator.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    patch_unit_json(&root, &unit, |value| {
        value["provenance"]["origin"] = serde_json::json!("generated");
        value["provenance"]["runner"] = serde_json::json!("codex");
        value["original"]["files"]["implementation.js"] =
            serde_json::json!(sha256_hex(b"older bytes"));
    });
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    assert_eq!(envelope(&result.stdout)["modified_since_generation"], true);
}

// ## Files scope: directly repaired saved files.

#[test]
fn files_scope_checks_repaired_bytes_against_owning_units() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    let js_rel = format!("can.generated/{unit}/implementation.js");
    write_file(dir.path(), &js_rel, KEYWORD_JS);
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    let result = validate_files(&root, dir.path(), "v.json", &[&js_rel]);
    assert_eq!(result.code, 0, "stdout: {}", result.stdout);
    let body = envelope(&result.stdout);
    assert_eq!(body["state"], "validated");
    let reports = body["files"].as_array().unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0]["unit"], serde_json::json!(unit));
    assert_eq!(reports[0]["kind"], serde_json::json!("keyword"));
    assert_eq!(
        reports[0]["sha256"],
        serde_json::json!(sha256_hex(KEYWORD_JS.as_bytes()))
    );
    let names: Vec<&str> = reports[0]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"exports"), "{names:?}");
    assert!(names.contains(&"imports"), "{names:?}");
    // Consumed siblings (record, declaration) are reported as such.
    let roles: Vec<(&str, &str)> = body["inputs"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap(), f["role"].as_str().unwrap()))
        .collect();
    assert!(roles.iter().any(|(p, r)| p == &js_rel && r == &"scope"));
    assert!(
        roles
            .iter()
            .any(|(p, r)| p.ends_with("/unit.json") && r == &"sibling")
    );
    // A repaired export removal diagnoses against the declaration.
    write_file(dir.path(), &js_rel, "export function other() {}\n");
    let broken = validate_files(&root, dir.path(), "v2.json", &[&js_rel]);
    assert_eq!(broken.code, 4, "stdout: {}", broken.stdout);
    let (_, message) = error_of(&broken.stdout);
    assert!(message.contains("canonicalKey"), "{message}");
}

#[test]
fn files_scope_rejects_non_saved_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    write_file(dir.path(), "app.can", GIVEN_APP);
    // Sources reconcile through adopt, not file validation.
    let result = validate_files(&root, dir.path(), "v.json", &["app.can"]);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains("not a saved output file"), "{message}");
}

// ## Maps locate actual saved JS; owner links attribute the `.can` intent.

#[test]
fn packed_maps_locate_saved_js_with_owner_links() {
    use canlang_compiler::codegen::artifact::{
        CanOwnerLink, CompileArtifact, pack_saved_unit, saved_unit_manifest_to_json,
        stage_saved_unit_modules,
    };
    use canlang_compiler::codegen::sourcemap::decode_mappings;
    let js = "export function canonicalKey(value) {\n  return value;\n}\n";
    let sha = sha256_hex(js.as_bytes());
    let revision = sha256_hex(GIVEN_APP.as_bytes());
    let owner = CanOwnerLink {
        unit_id: "u3".to_string(),
        kind: "keyword".to_string(),
        can_path: "app.can".to_string(),
        can_revision: revision.clone(),
        start: 10,
        end: 20,
    };
    let packed = pack_saved_unit(
        canlang_compiler::analysis::generation_intake::UnitKind::Keyword,
        owner,
        js.as_bytes(),
        &sha,
    )
    .expect("pack");
    // BGI-08 join path: the packing join writes saved `server.js` here.
    assert_eq!(packed.path, "can.generated/u3/server.js");
    assert_eq!(packed.js, js);
    assert_eq!(packed.map.js_sha256, sha);
    let rows = decode_mappings(&packed.map.map.mappings).unwrap();
    assert_eq!(rows.len(), 3);
    for (n, row) in rows.iter().enumerate() {
        assert_eq!(row.len(), 1);
        assert_eq!(row[0].src_line, Some(n as i64));
    }
    // Staging appends after existing modules; the entrypoint stays first.
    let mut artifact = CompileArtifact {
        language_version: "1.0".to_string(),
        tool_version: "test".to_string(),
        sources: vec![],
        modules: vec![canlang_compiler::codegen::artifact::ArtifactModule {
            path: "app/main.js".to_string(),
            js: "export const x = 1;\n".to_string(),
            map: packed.map.map.clone(),
        }],
        callables: vec![],
        operations: vec![],
        models: vec![],
        value_types: None,
        model_policies: None,
        committed_changes: None,
        pages: vec![],
        migrations: vec![],
        requires: vec![],
        tests: vec![],
    };
    stage_saved_unit_modules(&mut artifact, &[packed.clone()]).expect("stage");
    assert_eq!(artifact.modules.len(), 2);
    assert_eq!(artifact.modules[0].path, "app/main.js");
    assert_eq!(artifact.modules[1].path, "can.generated/u3/server.js");
    // Staging twice refuses; staging never overwrites.
    assert!(stage_saved_unit_modules(&mut artifact, &[packed.clone()]).is_err());
    // The owner manifest attributes the `.can` intent without inventing
    // executable prompt positions: unit, kind, path, revision, span.
    let manifest = saved_unit_manifest_to_json(&[packed]);
    assert!(!manifest.ends_with('\n'));
    let parsed: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(parsed[0]["path"], "can.generated/u3/server.js");
    assert_eq!(parsed[0]["sha256"], sha);
    assert_eq!(parsed[0]["owner"]["unitId"], "u3");
    assert_eq!(parsed[0]["owner"]["kind"], "keyword");
    assert_eq!(parsed[0]["owner"]["canPath"], "app.can");
    assert_eq!(parsed[0]["owner"]["canRevision"], revision);
    assert_eq!(parsed[0]["owner"]["start"], 10);
    assert_eq!(parsed[0]["owner"]["end"], 20);
}

#[test]
fn packing_refuses_mismatch_empty_and_non_js_kinds() {
    use canlang_compiler::analysis::generation_intake::UnitKind;
    use canlang_compiler::codegen::artifact::{CanOwnerLink, pack_saved_unit};
    let js = "export function canonicalKey(v) { return v; }\n";
    let sha = sha256_hex(js.as_bytes());
    let owner = || CanOwnerLink {
        unit_id: "u3".to_string(),
        kind: "keyword".to_string(),
        can_path: "app.can".to_string(),
        can_revision: "r".to_string(),
        start: 0,
        end: 1,
    };
    // Changed bytes refuse: re-validate before packing.
    assert!(pack_saved_unit(UnitKind::Keyword, owner(), js.as_bytes(), &"0".repeat(64)).is_err());
    // Empty bytes refuse.
    assert!(pack_saved_unit(UnitKind::Keyword, owner(), b"", &sha256_hex(b"")).is_err());
    // Style and trait units never pack JavaScript modules.
    let mut style_owner = owner();
    style_owner.kind = "style".to_string();
    assert!(pack_saved_unit(UnitKind::Style, style_owner, js.as_bytes(), &sha).is_err());
    let mut trait_owner = owner();
    trait_owner.kind = "named-trait".to_string();
    assert!(pack_saved_unit(UnitKind::NamedTrait, trait_owner, js.as_bytes(), &sha).is_err());
    // The owner link must name a unit of the packed kind.
    let mut wrong_kind = owner();
    wrong_kind.kind = "view".to_string();
    let err = pack_saved_unit(UnitKind::Keyword, wrong_kind, js.as_bytes(), &sha).unwrap_err();
    assert!(err.contains("owner link"), "{err}");
    let mut unnamed = owner();
    unnamed.unit_id.clear();
    assert!(pack_saved_unit(UnitKind::Keyword, unnamed, js.as_bytes(), &sha).is_err());
    // Views pack at their own staged path.
    let view = pack_saved_unit(
        UnitKind::View,
        CanOwnerLink {
            unit_id: "u5".to_string(),
            kind: "view".to_string(),
            can_path: "app.can".to_string(),
            can_revision: "r".to_string(),
            start: 0,
            end: 1,
        },
        VIEW_JS.as_bytes(),
        &sha256_hex(VIEW_JS.as_bytes()),
    )
    .expect("pack view");
    assert_eq!(view.path, "can.generated/u5/view.js");
}

// ## Saved-build determinism with zero AI/MCP processes.

#[test]
fn validation_is_deterministic_over_unchanged_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    let first = validate_unit(&root, dir.path(), "v1.json", &unit);
    let second = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(first.code, 0, "stdout: {}", first.stdout);
    assert_eq!(second.code, 0, "stdout: {}", second.stdout);
    // Same request id, same bytes: byte-identical envelopes.
    assert_eq!(first.stdout, second.stdout);
}

#[test]
fn clean_checkout_saved_build_needs_no_settings_or_mcp() {
    // A project with only `.can` sources and saved groups validates
    // and reports status with no `can.gen.toml`, no credentials, and
    // no MCP server: validate/status consult saved bytes only.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", GIVEN_APP);
    let unit = bind_new(
        &root,
        &file,
        GIVEN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/declaration.json"),
        KEYWORD_DECLARATION,
    );
    assert!(!dir.path().join("can.gen.toml").exists());
    let validated = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(validated.code, 0, "stdout: {}", validated.stdout);
    let request = request_file(
        dir.path(),
        "s.json",
        &format!(
            r#"{{"version":1,"request_id":"s1","operation":"status","root":{root:?},"files":[{file:?}]}}"#
        ),
    );
    let status = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(status.code, 0, "stdout: {}", status.stdout);
    let body = envelope(&status.stdout);
    assert_eq!(body["state"], "reported");
    // The workerd/browser actual-target gate stays explicitly open:
    // this suite qualifies interfaces, contracts, maps, and saved
    // builds here; execution on workerd/browser hardware is a held
    // external gate, reported rather than claimed.
}
