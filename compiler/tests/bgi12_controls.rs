//! BGI-12: compiler inspection seam for the control layer.
//!
//! Pins the additive `prompt`/`contract`/`span` fields on `can gen
//! status` units: the live prompt text, the fresh descriptor
//! contract, and the descriptor span for bind-new selection. These
//! fields feed BGI-12 capture (retry/generate prompts, recipe
//! agents, bind-new spans, adopt contract refresh); every other
//! status shape stays exactly as BGI-02/03 accepted it.

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

fn envelope(stdout: &str) -> serde_json::Value {
    serde_json::from_str(stdout).expect("dispatcher prints one JSON envelope")
}

const APP: &str = r#"app Tasks
Given
 trait completable $"Add done:bool=false with Open/Done labels."
 Todo {title:text trim min=1 max=200} completable
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
 style TaskSurface $"Readable task surfaces."
 page / title="Todos" $"A calm workspace."
  list Todo as task $TaskSurface
"#;

fn status_units(root: &str, dir: &std::path::Path, file: &str) -> serde_json::Value {
    let request = write_file(
        dir,
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
    body["units"].clone()
}

#[test]
fn status_carries_prompt_contract_and_span() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    let units = status_units(&root, dir.path(), &file);
    let units = units.as_array().unwrap();
    assert_eq!(units.len(), 3, "{units:?}");
    // The named style definition carries its live prompt text, the
    // fresh descriptor contract, and its descriptor span.
    let style = units
        .iter()
        .find(|unit| unit["kind"] == "style")
        .unwrap_or_else(|| panic!("{units:?}"));
    assert_eq!(style["association"], "new");
    assert_eq!(style["label"], "TaskSurface");
    assert_eq!(style["prompt"], "Readable task surfaces.");
    assert_eq!(
        style["contract"]["prompt_sha256"],
        sha256_hex("Readable task surfaces.".as_bytes())
    );
    assert_eq!(style["contract"]["profile"], serde_json::Value::Null);
    assert_eq!(style["contract"]["signature"], serde_json::Value::Null);
    let start = style["span"]["start"].as_u64().unwrap();
    let end = style["span"]["end"].as_u64().unwrap();
    assert!(start < end, "{style:?}");
    assert!(
        APP.as_bytes().get(start as usize..end as usize).is_some(),
        "{style:?}"
    );
    // The named trait carries its own prompt; kinds keep their shape.
    let named_trait = units
        .iter()
        .find(|unit| unit["kind"] == "named-trait")
        .unwrap_or_else(|| panic!("{units:?}"));
    assert_eq!(
        named_trait["prompt"],
        "Add done:bool=false with Open/Done labels."
    );
    assert_eq!(
        named_trait["contract"]["prompt_sha256"],
        sha256_hex("Add done:bool=false with Open/Done labels.".as_bytes())
    );
    // The page's inline prompt is its own one-off unit.
    let inline = units
        .iter()
        .find(|unit| unit["kind"] == "style-inline")
        .unwrap_or_else(|| panic!("{units:?}"));
    assert_eq!(inline["prompt"], "A calm workspace.");
    // The seam span selects the descriptor for bind-new: binding at
    // the reported span retains the unit on the next status.
    let revision = sha256_hex(APP.as_bytes());
    let bound = dispatch(&argv(&[
        "gen",
        "bind",
        &root,
        &file,
        &start.to_string(),
        &end.to_string(),
        &revision,
        "new",
    ]));
    assert_eq!(bound.code, 0, "stderr: {}", bound.stderr);
    let retained = status_units(&root, dir.path(), &file);
    let style = retained
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| unit["kind"] == "style")
        .unwrap();
    assert_eq!(style["association"], "retained");
    assert_eq!(style["prompt_changed"], false);
    assert_eq!(style["prompt"], "Readable task surfaces.");
}

#[test]
fn status_seam_matches_positional_and_orphans_stay_null() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = write_file(dir.path(), "app.can", APP);
    // Bind the style, then remove its source: the saved unit orphans.
    let (tree, _) = parse_source(SourceId(0), APP);
    let found = canlang_compiler::analysis::generation::discover_generation(&tree, APP);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == canlang_compiler::analysis::generation::GenerationKind::StyleDefinition)
        .unwrap();
    let revision = sha256_hex(APP.as_bytes());
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
    std::fs::write(&file, "app Tasks\nGiven\nWhen\nThen\n").unwrap();
    // JSON-request and positional JSON reports stay identical,
    // including the additive seam fields.
    let request = write_file(
        dir.path(),
        "status.json",
        &format!(
            r#"{{"version":1,"request_id":"s2","operation":"status","root":{root:?},"files":[{file:?}]}}"#
        ),
    );
    let via_json = dispatch(&argv(&["gen", "--request", &request]));
    assert_eq!(via_json.code, 0, "stdout: {}", via_json.stdout);
    let body = envelope(&via_json.stdout);
    let positional = dispatch(&argv(&["gen", "status", "--format=json", &root, &file]));
    assert_eq!(positional.code, 0, "stderr: {}", positional.stderr);
    let plain: serde_json::Value = serde_json::from_str(&positional.stdout).unwrap();
    assert_eq!(body["units"], plain["units"]);
    // The orphaned unit carries null seam fields: no live descriptor.
    let units = body["units"].as_array().unwrap();
    assert_eq!(units.len(), 1, "{units:?}");
    assert_eq!(units[0]["association"], "orphaned");
    assert_eq!(units[0]["prompt"], serde_json::Value::Null);
    assert_eq!(units[0]["contract"], serde_json::Value::Null);
    assert_eq!(units[0]["span"], serde_json::Value::Null);
}
