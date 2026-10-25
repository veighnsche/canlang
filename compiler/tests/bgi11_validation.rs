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
/// Returns the allocated opaque ID (new IDs contain 128 random bits).
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
 view TaskTile(row:Todo) $"Arrange admitted title/status and declared controls." $TaskSurface
  edit fields=title
  delete
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
    assert_eq!(
        body["inputs"]["source"]["path"],
        serde_json::json!("app.can")
    );
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
    assert!(paths.contains(&&"app.can"), "{paths:?}");
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
    let carrier_path = format!("can.generated/{unit}/contributions.can");
    let files = validate_files(&root, dir.path(), "files.json", &[&carrier_path]);
    assert_eq!(
        files.code, 0,
        "Given-only file validation: {}",
        files.stdout
    );
    for malformed in [
        "app Tasks\nWhen\nThen\n",
        "app Tasks\nGiven\n completable {done:bool=}\n",
    ] {
        write_file(dir.path(), &carrier_path, malformed);
        let files = validate_files(&root, dir.path(), "bad-files.json", &[&carrier_path]);
        assert_eq!(files.code, 4, "{}", files.stdout);
        assert!(files.stdout.contains("does not parse"), "{}", files.stdout);
    }
    for invalid in [
        "app Tasks\nGiven\n wrong_template {done:bool=false}\n",
        "app Tasks\nGiven\n completable {done:bool=\"bad\"}\n",
        "app Tasks\nGiven\n completable {done:bool=false}\nWhen\n scenario injected() by=public\n  do let supplied=1\nThen\n",
    ] {
        write_file(dir.path(), &carrier_path, invalid);
        let unit_result = validate_unit(&root, dir.path(), "bad-unit.json", &unit);
        assert_eq!(
            unit_result.code, 4,
            "unit contract must refuse invalid/effectful contribution: {}",
            unit_result.stdout
        );
    }
}

#[test]
fn field_trait_checks_validate_pack_and_reuse_the_checked_import_closure() {
    use canlang_compiler::analysis::types::given_closure_fingerprint;
    let source = "app FieldChecks\nGiven\n trait budget $\"Check the UTF-8 byte budget.\"\n Item {code:text budget,label:text budget,barcode:text trait $\"Check thirteen ASCII digits.\"}\nWhen\nThen\n";
    let named_carrier = "app FieldChecks\nGiven\n budget {value:text}\n";
    let inline_carrier = "app FieldChecks\nGiven\n Item {barcode:text}\n";
    let named_js = "import {limit} from './limit.js';\nexport function check(value) { return new TextEncoder().encode(value).length <= limit; }\n";
    let helper = "export const limit = 128;\n";
    let inline_js = "export function check(value) { return /^[0-9]{13}$/.test(value); }\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let named = bind_new(
        &root,
        &file,
        source,
        GenerationKind::NamedTrait,
        Some("budget"),
    );
    let inline = bind_new(&root, &file, source, GenerationKind::InlineTrait, None);
    for (unit, carrier, js) in [
        (&named, named_carrier, named_js),
        (&inline, inline_carrier, inline_js),
    ] {
        write_file(
            dir.path(),
            &format!("can.generated/{unit}/contributions.can"),
            carrier,
        );
        write_file(
            dir.path(),
            &format!("can.generated/{unit}/implementation.js"),
            js,
        );
    }
    // The named check consumes its actual local helper, never a fabricated bound.
    write_file(
        dir.path(),
        &format!("can.generated/{named}/limit.js"),
        helper,
    );
    let inline_validated = validate_unit(&root, dir.path(), "inline.json", &inline);
    assert_eq!(inline_validated.code, 0, "{}", inline_validated.stdout);
    assert_eq!(
        envelope(&inline_validated.stdout)["runtime_targets"],
        serde_json::json!(["check", "workerd"])
    );
    let validated = validate_unit(&root, dir.path(), "named.json", &named);
    assert_eq!(validated.code, 0, "{}", validated.stdout);
    let validated = envelope(&validated.stdout);
    assert_eq!(
        validated["runtime_targets"],
        serde_json::json!(["check", "workerd"])
    );
    let fingerprint = given_closure_fingerprint(
        named_carrier.as_bytes(),
        &[
            ("implementation.js", named_js.as_bytes()),
            ("limit.js", helper.as_bytes()),
        ],
    );
    assert_eq!(validated["fingerprint"], fingerprint);
    let js_path = format!("can.generated/{named}/implementation.js");
    let files = validate_files(&root, dir.path(), "files.json", &[&js_path]);
    assert_eq!(files.code, 0, "{}", files.stdout);
    let files = envelope(&files.stdout);
    for expected in [
        "app.can".to_string(),
        format!("can.generated/{named}/contributions.can"),
        format!("can.generated/{named}/limit.js"),
    ] {
        assert!(
            files["inputs"]["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["path"] == expected),
            "{expected}: {files}"
        );
    }
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = envelope(&compiled.stdout);
    assert_eq!(
        artifact["requires"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|requirement| requirement["capability"] == "state.field-validation")
            .collect::<Vec<_>>(),
        vec![&serde_json::json!({"capability":"state.field-validation","min_version":1})]
    );
    let traits = artifact["givenContracts"]["traits"].as_array().unwrap();
    assert_eq!(traits.len(), 3);
    let validation_fingerprint =
        given_closure_fingerprint(named_js.as_bytes(), &[("limit.js", helper.as_bytes())]);
    for instance in traits.iter().filter(|instance| instance["unitId"] == named) {
        assert_eq!(
            instance["fingerprint"],
            sha256_hex(named_carrier.as_bytes())
        );
        assert_eq!(
            instance["validation"],
            serde_json::json!({
                "producer":"state.field-validation@1","export":"check","lifecycle":"validate-fields",
                "input":{"name":"value","type":"text"},"result":{"type":"bool"},
                "reads":[],"effects":[],"authority":[],"fingerprint":validation_fingerprint
            })
        );
        assert!(instance["fields"][0].get("min").is_none());
        assert!(instance["fields"][0].get("max").is_none());
    }
    let modules = artifact["modules"].as_array().unwrap();
    for (path, js) in [
        (format!("can.generated/{named}/server.js"), named_js),
        (format!("can.generated/{named}/limit.js"), helper),
        (format!("can.generated/{inline}/server.js"), inline_js),
    ] {
        let packed = modules
            .iter()
            .filter(|module| module["path"] == path)
            .collect::<Vec<_>>();
        assert_eq!(packed.len(), 1, "{path}");
        assert_eq!(packed[0]["js"], js);
    }
    let changed = "export const limit = 64;\n";
    write_file(
        dir.path(),
        &format!("can.generated/{named}/limit.js"),
        changed,
    );
    let changed = validate_unit(&root, dir.path(), "changed.json", &named);
    assert_eq!(changed.code, 0, "{}", changed.stdout);
    assert_ne!(
        envelope(&changed.stdout)["fingerprint"],
        validated["fingerprint"]
    );
    std::fs::remove_file(dir.path().join(format!("can.generated/{named}/limit.js"))).unwrap();
    let missing = validate_unit(&root, dir.path(), "missing.json", &named);
    assert_eq!(missing.code, 4, "{}", missing.stdout);
    assert!(missing.stdout.contains("limit.js"));
    let missing = compile_json(dir.path(), &file);
    assert_eq!(missing.code, 10, "{}", missing.stdout);
    assert!(envelope(&missing.stdout).get("modules").is_none());
}

#[test]
fn field_trait_checks_refuse_unowned_exports_and_imports() {
    let source = "app FieldChecks\nGiven\n trait budget $\"Check bytes.\"\n Item {code:text budget}\nWhen\nThen\n";
    for (js, needle) in [
        (
            "export function unrelated(value) { return true; }\n",
            "check",
        ),
        (
            "import '../outside.js';\nexport function check(value) { return true; }\n",
            "..",
        ),
        (
            "import 'node:fs';\nexport function check(value) { return true; }\n",
            "node:fs",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = write_file(dir.path(), "app.can", source);
        let unit = bind_new(
            &root,
            &file,
            source,
            GenerationKind::NamedTrait,
            Some("budget"),
        );
        write_file(
            dir.path(),
            &format!("can.generated/{unit}/contributions.can"),
            "app FieldChecks\nGiven\n budget {value:text}\n",
        );
        let js_path = format!("can.generated/{unit}/implementation.js");
        write_file(dir.path(), &js_path, js);
        let validated = validate_unit(&root, dir.path(), "unit.json", &unit);
        assert_eq!(validated.code, 4, "{}", validated.stdout);
        assert!(validated.stdout.contains(needle), "{}", validated.stdout);
        let files = validate_files(&root, dir.path(), "files.json", &[&js_path]);
        assert_eq!(files.code, 4, "{}", files.stdout);
        let compiled = compile_json(dir.path(), &file);
        assert_eq!(compiled.code, 10, "{}", compiled.stdout);
        assert!(envelope(&compiled.stdout).get("modules").is_none());
    }
}

#[test]
fn model_trait_unit_with_saved_check_refuses() {
    // A pure field check cannot turn a model attachment into runtime authority.
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
        "app Tasks\nGiven\n completable {value:text=\"\"}\n",
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "export function check(value) { return value.length <= 128; }\n",
    );
    let result = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(result.code, 4, "stdout: {}", result.stdout);
    let (code, message) = error_of(&result.stdout);
    assert_eq!(code, "validation-failure");
    assert!(message.contains("E4056"), "{message}");
    assert!(message.contains(&unit), "{message}");
    let files = validate_files(
        &root,
        dir.path(),
        "files.json",
        &[&format!("can.generated/{unit}/implementation.js")],
    );
    assert_eq!(files.code, 4, "{}", files.stdout);
    assert!(files.stdout.contains("E4056"), "{}", files.stdout);
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
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=").unwrap();
    std::fs::create_dir_all(dir.path().join(format!("can.generated/{unit}/assets"))).unwrap();
    std::fs::write(
        dir.path()
            .join(format!("can.generated/{unit}/assets/bg.png")),
        png,
    )
    .unwrap();
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

#[test]
fn view_validation_requires_real_action_owners() {
    for (children, valid) in [
        ("  primary \"Browse\" target=\"/\"\n", false),
        (
            "  card row.title\n   require row.title != \"Hidden\"\n   text row.title\n   primary \"Browse\" target=\"/\"\n",
            true,
        ),
    ] {
        let source = format!(
            "app Tasks\nGiven\n Todo {{title:text}}\nWhen\nThen\n view Tile(row:Todo) $\"Arrange checked bindings.\"\n{children}"
        );
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = write_file(dir.path(), "app.can", &source);
        let unit = bind_new(
            &root,
            &file,
            &source,
            GenerationKind::ViewDefinition,
            Some("Tile"),
        );
        write_file(
            dir.path(),
            &format!("can.generated/{unit}/implementation.js"),
            "export function render({bindings}) { return bindings.card ?? ''; }\n",
        );
        let result = validate_unit(&root, dir.path(), "validate.json", &unit);
        if valid {
            assert_eq!(result.code, 0, "{}", result.stdout);
            assert_eq!(envelope(&result.stdout)["state"], "validated");
        } else {
            assert_eq!(result.code, 4, "{}", result.stdout);
            let (code, message) = error_of(&result.stdout);
            assert_eq!(code, "validation-failure");
            assert!(message.contains("owning card"), "{message}");
            assert!(message.contains(&unit), "{message}");
        }
    }
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
fn source_derived_declaration_and_legacy_strict_shape() {
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
    // Fresh units derive the admitted pure binding; no authored registry.
    let derived = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(derived.code, 0, "stdout: {}", derived.stdout);
    assert!(
        !dir.path()
            .join(format!("can.generated/{unit}/declaration.json"))
            .exists()
    );
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
        given_contracts: None,
        stylesheets: vec![],
        generated_views: vec![],
        value_types: None,
        model_policies: None,
        committed_changes: None,
        runtime_bindings: vec![],
        derived_bool_receipts: vec![],
        pages: vec![],
        migrations: vec![],
        requires: vec![],
        tests: vec![],
    };
    stage_saved_unit_modules(&mut artifact, std::slice::from_ref(&packed)).expect("stage");
    assert_eq!(artifact.modules.len(), 2);
    assert_eq!(artifact.modules[0].path, "app/main.js");
    assert_eq!(artifact.modules[1].path, "can.generated/u3/server.js");
    // Staging twice refuses; staging never overwrites.
    assert!(stage_saved_unit_modules(&mut artifact, std::slice::from_ref(&packed)).is_err());
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
    // Style units never pack JavaScript modules; checked field traits use the
    // same server path as the other checked Given implementations.
    let mut style_owner = owner();
    style_owner.kind = "style".to_string();
    assert!(pack_saved_unit(UnitKind::Style, style_owner, js.as_bytes(), &sha).is_err());
    let mut trait_owner = owner();
    trait_owner.kind = "named-trait".to_string();
    assert_eq!(
        pack_saved_unit(UnitKind::NamedTrait, trait_owner, js.as_bytes(), &sha)
            .unwrap()
            .path,
        "can.generated/u3/server.js"
    );
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

// ## Production join: the validated fingerprint covers the exact
// consumed unit-local import closure.

const CLOSURE_ROOT_JS: &str = "import { fold } from \"./fold.js\";\nexport function canonicalKey(value) { return fold(value); }\n";
const CLOSURE_FOLD_V1: &str =
    "export function fold(value) { return value.normalize(\"NFKC\").toLowerCase(); }\n";
const CLOSURE_FOLD_V2: &str = "export function fold(value) { return \"everything-collides\"; }\n";

fn fingerprint_of(stdout: &str) -> String {
    let body = envelope(stdout);
    assert_eq!(body["ok"], true, "{body}");
    body["fingerprint"].as_str().unwrap().to_string()
}

#[test]
fn closure_change_alters_validated_fingerprint() {
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
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        CLOSURE_ROOT_JS,
    );
    // Identical root bytes, NFKC-folding import: validates.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/fold.js"),
        CLOSURE_FOLD_V1,
    );
    let first = validate_unit(&root, dir.path(), "v1.json", &unit);
    assert_eq!(first.code, 0, "stdout: {}", first.stdout);
    let fp1 = fingerprint_of(&first.stdout);
    // The closure fingerprint is not the root-only hash: root-only
    // equality must not hide the consumed import.
    assert_ne!(fp1, sha256_hex(CLOSURE_ROOT_JS.as_bytes()));
    // Same root, constant-collision import: validates with a different
    // fingerprint (the import-probe regression: these were identical).
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/fold.js"),
        CLOSURE_FOLD_V2,
    );
    let second = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(second.code, 0, "stdout: {}", second.stdout);
    let fp2 = fingerprint_of(&second.stdout);
    assert_ne!(fp1, fp2, "closure change must alter the fingerprint");
    // Restoring the import restores the fingerprint: determinism over
    // unchanged bytes.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/fold.js"),
        CLOSURE_FOLD_V1,
    );
    let third = validate_unit(&root, dir.path(), "v3.json", &unit);
    assert_eq!(third.code, 0, "stdout: {}", third.stdout);
    assert_eq!(fingerprint_of(&third.stdout), fp1);
    // A bare unit without imports keeps the historical root-only hash.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    std::fs::remove_file(dir.path().join(format!("can.generated/{unit}/fold.js"))).unwrap();
    let bare = validate_unit(&root, dir.path(), "v4.json", &unit);
    assert_eq!(bare.code, 0, "stdout: {}", bare.stdout);
    assert_eq!(
        fingerprint_of(&bare.stdout),
        sha256_hex(KEYWORD_JS.as_bytes())
    );
}

#[test]
fn closure_escapes_and_missing_members_refuse() {
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
    // A `..` escape leaves the unit directory: unfingerprintable, so
    // it refuses instead of validating a partial closure.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "import { x } from \"../escape.js\";\nexport function canonicalKey(v) { return x(v); }\n",
    );
    let escaped = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(escaped.code, 4, "stdout: {}", escaped.stdout);
    let (_, message) = error_of(&escaped.stdout);
    assert!(message.contains("escapes the unit directory"), "{message}");
    // A missing member likewise refuses with its exact saved path.
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "import { x } from \"./absent.js\";\nexport function canonicalKey(v) { return x(v); }\n",
    );
    let missing = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(missing.code, 4, "stdout: {}", missing.stdout);
    let (_, message) = error_of(&missing.stdout);
    assert!(
        message.contains("no such saved file `absent.js`"),
        "{message}"
    );
}

#[test]
fn view_closure_change_alters_validated_fingerprint() {
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
        "import { part } from \"./part.js\";\nexport function render({row, bindings, ui}) { return part(bindings); }\n",
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/part.js"),
        "export function part(b) { return b.text; }\n",
    );
    let first = validate_unit(&root, dir.path(), "v.json", &unit);
    assert_eq!(first.code, 0, "stdout: {}", first.stdout);
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/part.js"),
        "export function part(b) { return \"constant\"; }\n",
    );
    let second = validate_unit(&root, dir.path(), "v2.json", &unit);
    assert_eq!(second.code, 0, "stdout: {}", second.stdout);
    assert_ne!(
        fingerprint_of(&first.stdout),
        fingerprint_of(&second.stdout),
        "view closure change must alter the fingerprint"
    );
}

#[test]
fn closure_pack_stages_root_and_siblings() {
    use canlang_compiler::analysis::generation_intake::UnitKind;
    use canlang_compiler::analysis::types::{GivenSavedImport, given_closure_fingerprint};
    use canlang_compiler::codegen::artifact::{
        CanOwnerLink, pack_saved_unit_closure, stage_saved_unit_modules,
    };
    let owner = CanOwnerLink {
        unit_id: "u9".to_string(),
        kind: "keyword".to_string(),
        can_path: "app.can".to_string(),
        can_revision: "r".to_string(),
        start: 0,
        end: 1,
    };
    let imports = vec![GivenSavedImport {
        rel_path: "fold.js".to_string(),
        bytes: CLOSURE_FOLD_V1.as_bytes().to_vec(),
    }];
    let refs: Vec<(&str, &[u8])> = imports
        .iter()
        .map(|i| (i.rel_path.as_str(), i.bytes.as_slice()))
        .collect();
    let fp = given_closure_fingerprint(CLOSURE_ROOT_JS.as_bytes(), &refs);
    let packed = pack_saved_unit_closure(
        UnitKind::Keyword,
        owner.clone(),
        CLOSURE_ROOT_JS.as_bytes(),
        &imports,
        &fp,
    )
    .expect("pack closure");
    assert_eq!(packed.len(), 2);
    assert_eq!(packed[0].path, "can.generated/u9/server.js");
    assert_eq!(packed[0].js, CLOSURE_ROOT_JS);
    assert_eq!(packed[1].path, "can.generated/u9/fold.js");
    assert_eq!(packed[1].js, CLOSURE_FOLD_V1);
    // Changed closure bytes refuse against the validated fingerprint.
    let changed = vec![GivenSavedImport {
        rel_path: "fold.js".to_string(),
        bytes: CLOSURE_FOLD_V2.as_bytes().to_vec(),
    }];
    let err = pack_saved_unit_closure(
        UnitKind::Keyword,
        owner.clone(),
        CLOSURE_ROOT_JS.as_bytes(),
        &changed,
        &fp,
    )
    .unwrap_err();
    assert!(err.contains("fingerprint mismatch"), "{err}");
    // Traversal and root-colliding members refuse before hashing.
    for rel in ["../escape.js", "server.js"] {
        let hostile = vec![GivenSavedImport {
            rel_path: rel.to_string(),
            bytes: b"x".to_vec(),
        }];
        assert!(
            pack_saved_unit_closure(
                UnitKind::Keyword,
                owner.clone(),
                CLOSURE_ROOT_JS.as_bytes(),
                &hostile,
                &fp
            )
            .is_err(),
            "{rel}"
        );
    }
    // Siblings stage beside the root in staged-path order.
    let mut artifact = canlang_compiler::codegen::artifact::CompileArtifact {
        language_version: "1.0".to_string(),
        tool_version: "test".to_string(),
        sources: vec![],
        modules: vec![],
        callables: vec![],
        operations: vec![],
        models: vec![],
        given_contracts: None,
        stylesheets: vec![],
        generated_views: vec![],
        value_types: None,
        model_policies: None,
        committed_changes: None,
        runtime_bindings: vec![],
        derived_bool_receipts: vec![],
        pages: vec![],
        migrations: vec![],
        requires: vec![],
        tests: vec![],
    };
    stage_saved_unit_modules(&mut artifact, &packed).expect("stage");
    assert_eq!(
        artifact
            .modules
            .iter()
            .map(|m| m.path.as_str())
            .collect::<Vec<_>>(),
        vec!["can.generated/u9/fold.js", "can.generated/u9/server.js"]
    );
}

// ## Production join: ordinary compilation consumes checked saved Given
// contributions (contributed fields, givenContracts, server modules).

/// Review fixture mirroring the production-join evidence: a named
/// trait plus the novel standalone keyword, each applied once.
const JOIN_APP: &str = r#"app Review
Given
 trait marked $"Add marked:bool=false."
 keyword canonical_identity(target:model,field:field(target,text)) $"NFKC then ASCII fold unique key."
 Account {handle:text} marked
 canonical_identity target=Account field=Account.handle
When
Then
 page / title="Review"
  text "hello"
"#;

const JOIN_CARRIER: &str = "app Review\nGiven\n marked {marked:bool=false}\n";
const JOIN_DECLARATION: &str = r#"{"producer":"state.unique-key@1","export":"canonicalKey","reads":[],"effects":[],"authority":[]}"#;
const JOIN_ROOT_JS: &str = "import { fold } from \"./fold.js\";\nexport function canonicalKey(value) { return fold(value); }\n";
const JOIN_FOLD_JS: &str =
    "export function fold(value) { return value.normalize(\"NFKC\").toLowerCase(); }\n";
const JOIN_CATALOG: &str = r#"{"language_version":"1.0","catalog_version":"1.0.0","entries":[]}"#;

fn compile_json(dir: &std::path::Path, file: &str) -> canlang_compiler::cli::DispatchResult {
    let catalog = write_file(dir, "catalog.json", JOIN_CATALOG);
    dispatch(&argv(&[
        "compile",
        "--format=json",
        &format!("--catalog={catalog}"),
        file,
    ]))
}

#[test]
fn compile_joins_saved_given_contributions_and_server_modules() {
    use canlang_compiler::analysis::types::given_closure_fingerprint;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", JOIN_APP);
    let u_trait = bind_new(
        &root,
        &file,
        JOIN_APP,
        GenerationKind::NamedTrait,
        Some("marked"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{u_trait}/contributions.can"),
        JOIN_CARRIER,
    );
    let u_kw = bind_new(
        &root,
        &file,
        JOIN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    // The compiler derives the keyword contract from source; no sidecar.
    assert!(
        !dir.path()
            .join(format!("can.generated/{u_kw}/declaration.json"))
            .exists()
    );
    write_file(
        dir.path(),
        &format!("can.generated/{u_kw}/implementation.js"),
        JOIN_ROOT_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{u_kw}/fold.js"),
        JOIN_FOLD_JS,
    );
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "stdout: {}", compiled.stdout);
    let body = envelope(&compiled.stdout);
    // The contributed field reaches the stored model descriptor the
    // runtime loads: boolean, defaulted, never caller-required.
    let models = body["models"].as_array().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["name"], "Review.Account");
    let fields = models[0]["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0]["name"], "handle");
    assert_eq!(fields[1]["name"], "marked");
    assert_eq!(fields[1]["field"]["kind"], "boolean");
    assert_eq!(fields[1]["valueType"], "bool");
    assert_eq!(fields[1]["required"], false);
    assert_eq!(fields[1]["default"]["kind"], "literal");
    assert_eq!(fields[1]["default"]["value"], false);
    // The checked contracts ride the artifact for compiler/runtime
    // consumers: trait instantiation plus keyword rule.
    let given = &body["givenContracts"];
    assert_eq!(given["traits"][0]["trait"], "marked");
    assert_eq!(given["traits"][0]["unitId"], u_trait);
    assert_eq!(given["traits"][0]["target"], "Review.Account");
    assert_eq!(given["traits"][0]["fields"][0]["name"], "marked");
    assert_eq!(
        given["traits"][0]["fingerprint"],
        sha256_hex(JOIN_CARRIER.as_bytes())
    );
    let rule = &given["keywords"][0];
    assert_eq!(rule["ruleId"], "Review.Account.handle#canonical_identity");
    assert_eq!(rule["unitId"], u_kw);
    assert_eq!(rule["producer"], "state.unique-key@1");
    assert_eq!(rule["export"], "canonicalKey");
    let expected_fp = given_closure_fingerprint(
        JOIN_ROOT_JS.as_bytes(),
        &[("fold.js", JOIN_FOLD_JS.as_bytes())],
    );
    assert_eq!(rule["fingerprint"], expected_fp);
    // The saved server module plus its import-closure sibling stage
    // after the entrypoint; the staged root keeps its checked bytes.
    let modules = body["modules"].as_array().unwrap();
    let paths: Vec<&str> = modules
        .iter()
        .map(|m| m["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        vec![
            "$can$m$526576696577.mjs",
            &format!("can.generated/{u_kw}/fold.js"),
            &format!("can.generated/{u_kw}/server.js"),
        ]
    );
    assert_eq!(modules[2]["js"], JOIN_ROOT_JS);
    assert_eq!(modules[1]["js"], JOIN_FOLD_JS);
    // Repeat saved builds are byte-identical with zero AI: no
    // generation settings exist and none are consulted.
    assert!(!dir.path().join("can.gen.toml").exists());
    let again = compile_json(dir.path(), &file);
    assert_eq!(again.code, 0, "stdout: {}", again.stdout);
    assert_eq!(again.stdout, compiled.stdout);
}

#[test]
fn compile_without_saved_given_diagnoses_the_unit_and_action() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", JOIN_APP);
    // Only the keyword binds: the applied trait has no saved unit.
    let u_kw = bind_new(
        &root,
        &file,
        JOIN_APP,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{u_kw}/declaration.json"),
        JOIN_DECLARATION,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{u_kw}/implementation.js"),
        "export function canonicalKey(v) { return v; }\n",
    );
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 10, "stdout: {}", compiled.stdout);
    let body = envelope(&compiled.stdout);
    let diags = body["diagnostics"].as_array().unwrap();
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0]["code"], "E6008");
    let message = diags[0]["message"].as_str().unwrap();
    assert!(message.contains("trait `marked`"), "{message}");
    assert!(message.contains("no saved unit"), "{message}");
    assert!(message.contains("action: generate"), "{message}");
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

#[test]
fn saved_model_trait_fields_check_before_when_and_then_bodies() {
    let source = "app Tasks\nGiven\n trait completable $\"Add done:bool=false.\"\n Item {title:text} completable\n Note {title:text} completable trait $\"Add pinned:bool=false.\"\nWhen\n scenario mark(note:Note) by=members\n  do set note {done=true,pinned=true}\nThen\n page / title=\"Tasks\"\n  table Note columns=title,done,pinned\n  list Item\n   text row.done\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let named = bind_new(
        &root,
        &file,
        source,
        GenerationKind::NamedTrait,
        Some("completable"),
    );
    let inline = bind_new(&root, &file, source, GenerationKind::InlineTrait, None);
    write_file(
        dir.path(),
        &format!("can.generated/{named}/contributions.can"),
        "app Tasks\nGiven\n completable {done:bool=false}\n",
    );
    write_file(
        dir.path(),
        &format!("can.generated/{inline}/contributions.can"),
        "app Tasks\nGiven\n Note {pinned:bool=false}\n",
    );
    // Unit preparation is independent of ordinary consumers of sibling fields.
    let validated = validate_unit(&root, dir.path(), "validation.json", &named);
    assert_eq!(validated.code, 0, "{}", validated.stdout);
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = envelope(&compiled.stdout);
    let models = artifact["models"].as_array().unwrap();
    let catalog = dir
        .path()
        .join("catalog.json")
        .to_string_lossy()
        .to_string();
    let checked = dispatch(&argv(&[
        "check",
        "--format=json",
        &format!("--catalog={catalog}"),
        &file,
    ]));
    assert_eq!(checked.code, 0, "{}", checked.stdout);
    assert!(
        envelope(&checked.stdout).get("modules").is_none(),
        "check emits no JS artifact"
    );
    let note = models
        .iter()
        .find(|model| model["name"] == "Tasks.Note")
        .unwrap();
    let fields = note["fields"].as_array().unwrap();
    assert_eq!(
        fields
            .iter()
            .filter(|field| field["name"] == "done")
            .count(),
        1
    );
    assert_eq!(
        fields
            .iter()
            .filter(|field| field["name"] == "pinned")
            .count(),
        1
    );
    assert!(
        artifact["modules"][0]["js"]
            .as_str()
            .unwrap()
            .contains("done:true")
    );
    // A real unresolved field still refuses; successful contributions cannot hide it.
    let broken = source.replace(
        "columns=title,done,pinned",
        "columns=title,done,pinned,absent",
    );
    write_file(dir.path(), "app.can", &broken);
    let refused = compile_json(dir.path(), &file);
    assert_eq!(refused.code, 10, "{}", refused.stdout);
    assert!(refused.stdout.contains("absent"), "{}", refused.stdout);
    let refused = dispatch(&argv(&[
        "check",
        "--format=json",
        &format!("--catalog={catalog}"),
        &file,
    ]));
    assert_eq!(refused.code, 10, "{}", refused.stdout);
    assert!(refused.stdout.contains("absent"), "{}", refused.stdout);
}

#[test]
fn reused_keyword_keeps_two_rules_and_stages_one_owned_implementation_closure() {
    let source = "app Shared\nGiven\n keyword canonical_identity(target:model,field:field(target,text)) $\"Compute canonical keys.\"\n Account {handle:text}\n Alias {handle:text}\n canonical_identity target=Account field=Account.handle\n canonical_identity target=Alias field=Alias.handle\nWhen\nThen\n page / title=\"Accounts\"\n  text \"Shared keyword\"\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let unit = bind_new(
        &root,
        &file,
        source,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        JOIN_ROOT_JS,
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/fold.js"),
        JOIN_FOLD_JS,
    );
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = envelope(&compiled.stdout);
    let rules = artifact["givenContracts"]["keywords"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    assert!(rules.iter().all(|rule| rule["unitId"] == unit));
    let modules = artifact["modules"].as_array().unwrap();
    assert_eq!(
        modules
            .iter()
            .filter(|module| module["path"] == format!("can.generated/{unit}/server.js"))
            .count(),
        1
    );
    assert_eq!(
        modules
            .iter()
            .filter(|module| module["path"] == format!("can.generated/{unit}/fold.js"))
            .count(),
        1
    );
}

#[test]
fn existing_field_trait_defaults_allow_omission_and_preserve_authored_labels_and_defaults() {
    let source = "app Tasks\nGiven\n trait pending_review $\"Default boolean to true.\"\n Item {title:text,hidden:bool pending_review desc=\"Hidden source description\" label=\"Hidden\"@{nl=\"Verborgen\"},pinned:bool trait $\"Default pinned to true.\" desc=\"Pinned source description\" label=\"Pinned\",locked:bool=false label=\"Locked\"}\nWhen\n scenario add() by=members\n  do create Item {title=\"New\"} as created\n crud Item by=members fields=title\nThen\n page / title=\"Tasks\"\n  form Item.create fields=title\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let named = bind_new(
        &root,
        &file,
        source,
        GenerationKind::NamedTrait,
        Some("pending_review"),
    );
    let inline = bind_new(&root, &file, source, GenerationKind::InlineTrait, None);
    write_file(
        dir.path(),
        &format!("can.generated/{named}/contributions.can"),
        "app Tasks\nGiven\n pending_review {value:bool=true label=\"Template hidden\"}\n",
    );
    write_file(
        dir.path(),
        &format!("can.generated/{inline}/contributions.can"),
        "app Tasks\nGiven\n Item {pinned:bool=true label=\"Template pinned\"}\n",
    );
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let generated = envelope(&compiled.stdout);
    let entry = generated["modules"][0]["js"].as_str().unwrap();
    assert!(entry.contains("\"Hidden\",{nl:\"Verborgen\"}"), "{entry}");
    assert!(entry.contains("\"Pinned\""), "{entry}");
    assert!(
        !entry.contains("Template hidden") && !entry.contains("Template pinned"),
        "{entry}"
    );
    let fields = generated["models"][0]["fields"].as_array().unwrap();
    for (name, expected) in [("hidden", true), ("pinned", true), ("locked", false)] {
        let field = fields.iter().find(|field| field["name"] == name).unwrap();
        assert_eq!(field["default"]["value"], expected, "{field}");
        assert_eq!(field["required"], false, "{field}");
        if name != "locked" {
            assert_eq!(
                field["description"],
                if name == "hidden" {
                    "Hidden source description"
                } else {
                    "Pinned source description"
                }
            );
        }
    }
    let direct = source
        .replace(" trait pending_review $\"Default boolean to true.\"\n", "")
        .replace("hidden:bool pending_review", "hidden:bool=true")
        .replace(
            "pinned:bool trait $\"Default pinned to true.\"",
            "pinned:bool=true",
        )
        .replace("locked:bool=false pending_review", "locked:bool=false");
    write_file(dir.path(), "app.can", &direct);
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let authored = envelope(&compiled.stdout);
    assert_eq!(generated["models"], authored["models"]);
    assert_eq!(generated["operations"], authored["operations"]);
}

#[test]
fn saved_field_traits_reach_model_and_crud_input_constraints() {
    let source = "app Tasks\nGiven\n trait clean $\"Trim text with length bounds.\"\n Item {title:text clean,handle:text trait $\"Trim and bound the handle.\"}\n Note {body:text clean}\nWhen\n crud Item by=members fields=title,handle\n crud Note by=members fields=body\nThen\n page / title=\"Tasks\"\n  form Item.create fields=title,handle\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let named = bind_new(
        &root,
        &file,
        source,
        GenerationKind::NamedTrait,
        Some("clean"),
    );
    let inline = bind_new(&root, &file, source, GenerationKind::InlineTrait, None);
    write_file(
        dir.path(),
        &format!("can.generated/{named}/contributions.can"),
        "app Tasks\nGiven\n clean {value:text trim min=1 max=80}\n",
    );
    write_file(
        dir.path(),
        &format!("can.generated/{inline}/contributions.can"),
        "app Tasks\nGiven\n Item {handle:text trim min=1 max=40}\n",
    );
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = envelope(&compiled.stdout);
    let item = artifact["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["name"] == "Tasks.Item")
        .unwrap();
    for (name, maximum) in [("title", 80), ("handle", 40)] {
        let field = item["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["name"] == name)
            .unwrap();
        assert_eq!(field["trim"], true);
        assert_eq!(field["min"], 1);
        assert_eq!(field["max"], maximum);
    }
    // Compare the existing admission split fairly with equivalent authored fields:
    // canonical model decoding owns scalar normalization/bounds, not the input schema.
    let handwritten = source
        .replace(" trait clean $\"Trim text with length bounds.\"\n", "")
        .replace("title:text clean", "title:text trim min=1 max=80")
        .replace(
            "handle:text trait $\"Trim and bound the handle.\"",
            "handle:text trim min=1 max=40",
        )
        .replace("body:text clean", "body:text trim min=1 max=80");
    write_file(dir.path(), "app.can", &handwritten);
    let direct = compile_json(dir.path(), &file);
    assert_eq!(direct.code, 0, "{}", direct.stdout);
    let direct = envelope(&direct.stdout);
    assert_eq!(artifact["operations"], direct["operations"]);
    assert_eq!(artifact["models"], direct["models"]);
}

#[test]
fn saved_binding_relocates_without_old_source_or_ai() {
    let old = tempfile::tempdir().unwrap();
    let root = old.path().to_string_lossy().to_string();
    let source = GIVEN_APP
        .replace(
            " trait completable $\"Add done:bool=false with Open/Done labels.\"\n",
            "",
        )
        .replace("} completable", "}")
        .replace(" trait $\"Add pinned:bool=false.\"", "");
    let file = write_file(old.path(), "app.can", &source);
    let unit = bind_new(
        &root,
        &file,
        &source,
        GenerationKind::KeywordDefinition,
        Some("canonical_identity"),
    );
    write_file(
        old.path(),
        &format!("can.generated/{unit}/implementation.js"),
        KEYWORD_JS,
    );
    let record: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(old.path().join(format!("can.generated/{unit}/unit.json")))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(record["source"]["path"], "app.can");
    let fresh = tempfile::tempdir().unwrap();
    for name in [
        "app.can".to_string(),
        format!("can.generated/{unit}/unit.json"),
        format!("can.generated/{unit}/implementation.js"),
    ] {
        let target = fresh.path().join(&name);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(old.path().join(&name), target).unwrap();
    }
    drop(old);
    let fresh_root = fresh.path().to_string_lossy().to_string();
    let status = dispatch(&argv(&[
        "gen",
        "status",
        "--format=json",
        &fresh_root,
        "app.can",
    ]));
    assert_eq!(status.code, 0, "{}", status.stdout);
    assert!(status.stdout.contains("\"retained\""), "{}", status.stdout);
    let validated = validate_unit(&fresh_root, fresh.path(), "validate.json", &unit);
    assert_eq!(validated.code, 0, "{}", validated.stdout);
    let compiled = compile_json(
        fresh.path(),
        &fresh.path().join("app.can").to_string_lossy(),
    );
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    assert!(compiled.stdout.contains("givenContracts"));
}

#[test]
fn owned_css_assets_pack_checked_bytes_and_encoded_routes_only() {
    let source = "app Tasks\nGiven\n Todo {title:text}\nWhen\nThen\n style Surface $\"Use an owned texture.\"\n page / title=\"Assets\" $Surface\n  text \"Body\"\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let unit = bind_new(
        &root,
        &file,
        source,
        GenerationKind::StyleDefinition,
        Some("Surface"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/style.css"),
        "section {background:url(\"asset with space.bin?rev=2#texture\");}\n",
    );
    let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=").unwrap();
    std::fs::write(
        dir.path()
            .join(format!("can.generated/{unit}/asset with space.bin")),
        &png,
    )
    .unwrap();
    std::fs::write(
        dir.path().join(format!("can.generated/{unit}/unused.bin")),
        b"unused",
    )
    .unwrap();
    let validated = validate_unit(&root, dir.path(), "validate.json", &unit);
    assert_eq!(validated.code, 0, "{}", validated.stdout);
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = envelope(&compiled.stdout);
    let sheet = &artifact["stylesheets"][0];
    assert!(sheet["css"].as_str().unwrap().contains(&format!(
        "/assets/can.generated/{unit}/asset%20with%20space.bin?rev=2#texture"
    )));
    let assets = sheet["assets"].as_array().unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(
        assets[0]["path"],
        format!("can.generated/{unit}/asset with space.bin")
    );
    assert_eq!(assets[0]["contentType"], "image/png");
    assert_eq!(assets[0]["sha256"], sha256_hex(&png));
    assert_eq!(
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            assets[0]["contentBase64"].as_str().unwrap()
        )
        .unwrap(),
        png
    );
    std::fs::write(
        dir.path()
            .join(format!("can.generated/{unit}/asset with space.bin")),
        b"<html>not an image</html>",
    )
    .unwrap();
    let refused = validate_unit(&root, dir.path(), "invalid.json", &unit);
    assert_eq!(refused.code, 4, "{}", refused.stdout);
    assert!(
        refused
            .stdout
            .contains("unsupported or mismatched owned asset type")
    );
}

#[test]
fn contributed_field_labels_reach_app_definition_and_prepared_forms() {
    let source = r#"app Captions source="nl"
Given
 trait archive_evidence $"Add archive fields with clear labels."
 Entry {title:text} archive_evidence
 Tag {name:text} archive_evidence
 Note {body:text} trait $"Add pinned with its caption."
When
 crud Entry by=members fields=title,archive_recorded_at
 crud Tag by=members fields=name,archive_recorded_at
 crud Note by=members fields=body,pinned
Then
 page / title="Entries"
  form Entry.create fields=title,archive_recorded_at
  form Tag.create fields=name,archive_recorded_at
  form Note.create fields=body,pinned
"#;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let named = bind_new(
        &root,
        &file,
        source,
        GenerationKind::NamedTrait,
        Some("archive_evidence"),
    );
    let inline = bind_new(&root, &file, source, GenerationKind::InlineTrait, None);
    for (unit, carrier) in [
        (
            &named,
            "app Captions\nGiven\n archive_evidence {archive_recorded_at:datetime?=null label=\"Archive time\"}\n",
        ),
        (
            &inline,
            "app Captions\nGiven\n Note {pinned:bool=false label=\"Pinned\"}\n",
        ),
    ] {
        write_file(
            dir.path(),
            &format!("can.generated/{unit}/contributions.can"),
            carrier,
        );
        let validated = validate_unit(&root, dir.path(), &format!("{unit}.json"), unit);
        assert_eq!(validated.code, 0, "{}", validated.stdout);
    }
    let compiled = compile_json(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = envelope(&compiled.stdout);
    let entry = artifact["modules"][0]["js"].as_str().unwrap();
    let message = "$can$h$636865636b65645f6d657373616765";
    let archive = format!("{message}(\"Archive time\",{{}},undefined,\"nl\")");
    let pinned = format!("{message}(\"Pinned\",{{}},undefined,\"nl\")");
    assert_eq!(
        entry.matches(&format!("label:{archive}")).count(),
        2,
        "{entry}"
    );
    assert_eq!(
        entry.matches(&format!("label:{pinned}")).count(),
        1,
        "{entry}"
    );
    for (operation, name, caption) in [
        ("Entry.create", "archive_recorded_at", &archive),
        ("Tag.create", "archive_recorded_at", &archive),
        ("Note.create", "pinned", &pinned),
    ] {
        let request = entry
            .split_once(&format!("prepareForm({{operation:\"Captions.{operation}\""))
            .expect("canonical prepared form")
            .1
            .split_once(",labels:")
            .expect("contributed caption request")
            .1;
        assert!(
            request.starts_with(&format!("{{{name}:{caption}}}")),
            "{request}"
        );
    }
    write_file(
        dir.path(),
        &format!("can.generated/{inline}/contributions.can"),
        "app Captions\nGiven\n Note {pinned:bool=false label=\"Pinned {value}\"}\n",
    );
    let refused = validate_unit(&root, dir.path(), "bad-caption.json", &inline);
    assert_eq!(refused.code, 4, "{}", refused.stdout);
    assert!(
        refused.stdout.contains("invalid contributed field label"),
        "{}",
        refused.stdout
    );
    let refused = compile_json(dir.path(), &file);
    assert_eq!(refused.code, 10, "{}", refused.stdout);
    assert!(envelope(&refused.stdout).get("modules").is_none());
}

#[test]
fn contributed_defaults_and_bounds_match_authored_exact_wire_values() {
    let fields = "count:int=9223372036854775807 min=1 max=9223372036854775807, ratio:decimal=1.50 min=1.25 max=2.00, maybe:decimal?=null min=1.25 max=2.00, words:text[]=[\"a  b\",\"x,y\"] min=1 max=3, choices:enum(open,done)[]=[open,done], delay:duration=2s min=1s max=3s, at:datetime=\"2026-10-14T12:00:00+02:00\"";
    let source = "app Tasks\nGiven\n trait marked $\"Add exact native defaults.\"\n Item {title:text} marked\nWhen\n crud Item by=members fields=title\nThen\n page / title=\"Tasks\"\n  form Item.create fields=title\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", source);
    let catalog = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages/values/dist/catalog.json");
    let compile = || {
        dispatch(&argv(&[
            "compile",
            "--format=json",
            &format!("--catalog={}", catalog.display()),
            &file,
        ]))
    };
    let unit = bind_new(
        &root,
        &file,
        source,
        GenerationKind::NamedTrait,
        Some("marked"),
    );
    write_file(
        dir.path(),
        &format!("can.generated/{unit}/contributions.can"),
        &format!("app Tasks\nGiven\n marked {{{fields}}}\n"),
    );
    let compiled = compile();
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let generated = envelope(&compiled.stdout);
    let model_fields = generated["models"][0]["fields"].as_array().unwrap();
    for (name, expected) in [
        ("count", serde_json::json!("9223372036854775807")),
        ("ratio", serde_json::json!("1.50")),
        ("maybe", serde_json::Value::Null),
        ("words", serde_json::json!(["a  b", "x,y"])),
        ("choices", serde_json::json!(["open", "done"])),
        ("delay", serde_json::json!("2000")),
        ("at", serde_json::json!("2026-10-14T10:00:00.000Z")),
    ] {
        let field = model_fields
            .iter()
            .find(|field| field["name"] == name)
            .unwrap();
        assert_eq!(field["default"]["value"], expected, "{field}");
    }
    let direct_fields = fields.replace(
        "at:datetime=\"2026-10-14T12:00:00+02:00\"",
        "at:datetime=datetime(\"2026-10-14T12:00:00+02:00\")",
    );
    let direct = source
        .replace(" trait marked $\"Add exact native defaults.\"\n", "")
        .replace(
            "Item {title:text} marked",
            &format!("Item {{title:text, {direct_fields}}}"),
        );
    write_file(dir.path(), "app.can", &direct);
    let compiled = compile();
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let authored = envelope(&compiled.stdout);
    assert_eq!(generated["models"], authored["models"]);
    assert_eq!(generated["operations"], authored["operations"]);
}

#[test]
fn actual_promptlab_create_results_keep_checked_saved_disclosure() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let result = dispatch(&[
        "can".into(),
        "compile".into(),
        "--format=json".into(),
        "--native-scenario-receipts".into(),
        format!(
            "--catalog={}",
            root.join("packages/cloudflare/dist/native-catalog.json")
                .display()
        ),
        root.join("draft/apps/CanPromptLab/CanPromptLab.can")
            .display()
            .to_string(),
    ]);
    assert_eq!(result.code, 0, "{} {}", result.stdout, result.stderr);
    let artifact = envelope(&result.stdout);
    for name in ["prompt_lab.add_entry", "prompt_lab.add_tag"] {
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == name)
            .unwrap();
        assert!(
            operation["result"]["disclosure"].is_object(),
            "{name}: {operation}"
        );
    }
}
