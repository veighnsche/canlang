//! Native example inventory, row/resource ownership, currentness and safe projections.
//! The Testkit bridge binds compiled JavaScript closures to canonical Can APIs only.
use crate::capture::{self, Capture, InventoryProvider};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path},
    sync::{Mutex, OnceLock, atomic::AtomicBool},
};

pub type Result<T> = std::result::Result<T, String>;
pub type Call<'a> = dyn Fn(&str, Option<&str>, Value, &AtomicBool) -> Result<Value> + 'a;
const MAX_MODULES: usize = 32_000;
const MAX_ROWS: usize = 100_000;
static RETAINED_STAGING: OnceLock<Mutex<BTreeMap<String, Vec<tempfile::TempDir>>>> =
    OnceLock::new();
/// Called only after the bridge has joined and released this entire parent resource group.
pub fn release_staging(generation: &str) {
    if let Some(retained) = RETAINED_STAGING.get() {
        retained.lock().unwrap().remove(generation);
    }
}
fn retain_staging(generation: &str, directory: tempfile::TempDir) {
    RETAINED_STAGING
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap()
        .entry(generation.to_owned())
        .or_default()
        .push(directory);
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or_else(|| format!("example recipe {key} must be bounded nonempty text"))
}
fn encoded(value: &Value) -> Result<Vec<u8>> {
    let value = value
        .as_str()
        .ok_or("example recipe bytes must be base64")?;
    if value.len() > 32 * 1024 * 1024 {
        return Err("example recipe bytes exceed limit".into());
    }
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| "example recipe bytes are invalid base64")?;
    if STANDARD.encode(&decoded) != value {
        return Err("example recipe bytes are not canonical base64".into());
    }
    Ok(decoded)
}
fn relative_module(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}
#[derive(Debug)]
struct Recipe {
    artifact: Value,
    digest: String,
}
fn validate_artifact_modules(artifact: &Value) -> Result<()> {
    let modules = artifact["modules"]
        .as_array()
        .ok_or("example artifact modules are absent")?;
    let tests = artifact["tests"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("example artifact has zero compiled test modules")?;
    if modules.len() + tests.len() > MAX_MODULES {
        return Err("example artifact module limit".into());
    }
    let mut paths = BTreeSet::new();
    for module in modules.iter().chain(tests.iter().map(|t| &t["module"])) {
        let path = text(module, "path")?;
        if !relative_module(path)
            || !paths.insert(path.to_owned())
            || !module["js"].is_string()
            || !module["map"].is_object()
        {
            return Err("example artifact module path/source is invalid or duplicated".into());
        }
    }
    for test in tests {
        text(test, "scope")?;
        if !test["fixtures"]
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string))
        {
            return Err("example artifact fixture inventory is invalid".into());
        }
    }
    Ok(())
}
fn recipe(value: &Value, source_revision: &str) -> Result<Recipe> {
    for key in [
        "artifactLabel",
        "sourceRevision",
        "workerName",
        "compatibilityDate",
        "d1Binding",
    ] {
        text(value, key)?;
    }
    if value["sourceRevision"] != source_revision {
        return Err("example recipe source differs from capture".into());
    }
    let bytes = encoded(&value["artifactBytes"])?;
    let artifact: Value =
        serde_json::from_slice(&bytes).map_err(|_| "example artifact is invalid JSON")?;
    if artifact["artifact_version"] != 1 {
        return Err("example artifact version is unsupported".into());
    }
    validate_artifact_modules(&artifact)?;
    let worker = &value["worker"];
    let main = text(worker, "mainModule")?;
    let worker_modules = worker["modules"]
        .as_object()
        .ok_or("example Worker modules are absent")?;
    if worker_modules.len() > MAX_MODULES
        || !worker_modules.contains_key(main)
        || worker_modules
            .iter()
            .any(|(name, source)| !relative_module(name) || !source.is_string())
    {
        return Err("example Worker module inventory is invalid".into());
    }
    let binaries = worker["binaryModules"]
        .as_object()
        .ok_or("example binary module inventory is invalid")?;
    if binaries.len() + worker_modules.len() > MAX_MODULES {
        return Err("example Worker module limit".into());
    }
    for (name, value) in binaries {
        if !relative_module(name) || worker_modules.contains_key(name) {
            return Err("example binary module path collision".into());
        }
        encoded(value)?;
    }
    Ok(Recipe {
        artifact,
        digest: format!("{:x}", Sha256::digest(&bytes)),
    })
}
fn selected(value: Option<&Value>) -> Result<Option<(&str, u64)>> {
    value
        .map(|v| {
            let operation = text(v, "operation")?;
            let row = v["rowIndex"]
                .as_u64()
                .filter(|v| *v <= 9_007_199_254_740_991)
                .ok_or("example selected row index is invalid")?;
            Ok((operation, row))
        })
        .transpose()
}
fn rows(metadata: &Value, test: &Value, selection: Option<(&str, u64)>) -> Result<Vec<u64>> {
    let rows = metadata["rows"]
        .as_array()
        .ok_or("Testkit row metadata is absent")?;
    if rows.len() > MAX_ROWS {
        return Err("Testkit row limit exceeded".into());
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for row in rows {
        let index = row["rowIndex"]
            .as_u64()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or("Testkit row index is invalid")?;
        if !seen.insert(index) {
            return Err("Testkit row index is duplicated".into());
        }
        if selection.is_none_or(|(_, selected)| selected == index) {
            result.push(index);
        }
    }
    if rows.is_empty()
        && test["fixtures"]
            .as_array()
            .is_some_and(|v| v.contains(&test["scope"]))
    {
        return Ok(result);
    }
    if result.is_empty() {
        return Err("example selected module emitted zero executable rows".into());
    }
    if selection.is_some() && result.len() != 1 {
        return Err("example selected row is unavailable or ambiguous".into());
    }
    Ok(result)
}
fn current(
    capture: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
) -> Result<()> {
    capture::check_cancel(cancel)?;
    if !capture::runtime_inputs_current(capture, inventory, cancel) {
        return Err("captured example runtime inputs changed".into());
    }
    capture::check_cancel(cancel)
}
fn release(call: &Call<'_>, command: &str, generation: &str, payload: Value) -> Result<()> {
    // Cancellation never skips joining/disposal. Bridge retains failed releases in this parent group.
    call(command, Some(generation), payload, &AtomicBool::new(false)).map(|_| ())
}
fn checked_case(value: Value, operation: &str, row: u64) -> Result<Value> {
    if value["kind"] != "table"
        || value["operation"] != operation
        || !value["rows"].as_array().is_some_and(|v| {
            v.len() == 1
                && v[0]["rowIndex"] == row
                && matches!(
                    v[0]["outcome"].as_str(),
                    Some("passed" | "failed" | "setup-failed" | "unsupported")
                )
        })
    {
        return Err("Testkit returned incomplete or mismatched row results".into());
    }
    Ok(value)
}

/// Run immutable compiled recipes without borrowing any serving database or actor.
/// Every allocation is named before the RPC, including allocations completing after cancellation.
fn validate_run_id(run_id: &str) -> Result<()> {
    if run_id.is_empty()
        || run_id.len() > 64
        || !run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("example run identity is invalid".into());
    }
    Ok(())
}
fn distinct_bindings(artifact: &Value, input: &Value) -> Result<()> {
    if artifact["models"]
        .as_array()
        .is_some_and(|models| !models.is_empty())
        && matches!(
            text(input, "d1Binding")?,
            "CAN_EXAMPLE_STATE_CURRENT" | "CAN_EXAMPLE_STATE_OTHER"
        )
    {
        return Err("example D1 bindings must be distinct".into());
    }
    Ok(())
}
fn apply_recipe_date(options: &mut Value, input: &Value) {
    // Preserve this exact recipe's date; it is part of the immutable Worker recipe.
    if let Some(workers) = options["options"]["workers"].as_array_mut() {
        for worker in workers {
            worker["compatibilityDate"] = input["compatibilityDate"].clone();
        }
    }
}
fn finish_row(resource: Result<Value>, disposed: Result<()>) -> Result<Value> {
    match (resource, disposed) {
        (_, Err(error)) => Err(format!("example row cleanup remains owned: {error}")),
        (Err(error), _) => Err(error),
        (Ok(result), Ok(())) => Ok(result["rows"][0].clone()),
    }
}
fn completed_report(
    capture: &Capture,
    generation: &str,
    digest: &str,
    cases: Vec<Value>,
    count: usize,
    call: &Call<'_>,
    cancel: &AtomicBool,
) -> Result<Value> {
    capture::check_cancel(cancel)?;
    let expected_cases = json!(cases);
    let report = call(
        "testkit.report",
        Some(generation),
        json!({"applicationRoot":capture.root,"artifactDigest":digest,
        "sourceRevision":capture.source_revision,"cases":expected_cases}),
        cancel,
    )?;
    if report["cases"] != expected_cases {
        return Err("example report cases differ from completed rows".into());
    }
    validate_report(&report, &digest, &capture.source_revision, count)?;
    Ok(report)
}
pub fn run(
    input: &Value,
    capture: &Capture,
    generation: &str,
    run_id: &str,
    selection: Option<&Value>,
    context: Option<&Value>,
    inventory: &InventoryProvider<'_>,
    call: &Call<'_>,
    cancel: &AtomicBool,
) -> Result<Value> {
    validate_run_id(run_id)?;
    let recipe = recipe(input, &capture.source_revision)?;
    let selection = selected(selection)?;
    distinct_bindings(&recipe.artifact, input)?;
    current(capture, inventory, cancel)?;
    let tests = recipe.artifact["tests"].as_array().unwrap();
    let mut cases = Vec::new();
    let mut count = 0usize;
    for (module_index, test) in tests.iter().enumerate() {
        let operation = text(test, "scope")?;
        if selection.is_some_and(|(selected, _)| selected != operation) {
            continue;
        }
        capture::check_cancel(cancel)?;
        let directory = tempfile::Builder::new()
            .prefix("can-example-modules-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let suite = format!("example-suite-{}", crate::preview::random_id()?);
        let suite_input = json!({"applicationRoot":capture.root,"artifactBytes":input["artifactBytes"],
            "artifactLabel":input["artifactLabel"],"sourceRevision":capture.source_revision,"workDir":directory.path()});
        let outcome = (|| -> Result<()> {
            let metadata = call(
                "testkit.load",
                Some(generation),
                json!({"suite":suite,"input":suite_input,"moduleIndex":module_index}),
                cancel,
            )?;
            let selected_rows = rows(&metadata, test, selection)?;
            let mut case_rows = Vec::new();
            for row in selected_rows {
                capture::check_cancel(cancel)?;
                let handle = format!("example-row-{}", crate::preview::random_id()?);
                let d1 = crate::preview::random_id()?;
                let state_current = crate::preview::random_id()?;
                let state_other = crate::preview::random_id()?;
                let databases = json!({(text(input,"d1Binding")?):d1,"CAN_EXAMPLE_STATE_CURRENT":state_current,"CAN_EXAMPLE_STATE_OTHER":state_other});
                let worker_name = format!("can-example-{module_index}-{row}-{}", &d1[..8]);
                let (mut options, _) = crate::preview::isolated_options(
                    &handle,
                    &worker_name,
                    &input["worker"],
                    databases,
                    json!({}),
                )?;
                apply_recipe_date(&mut options, input);
                let resource = (|| -> Result<Value> {
                    call("mf.create", Some(generation), options, cancel)?;
                    let result = call(
                        "testkit.row",
                        Some(generation),
                        json!({"suite":suite,"row":row,"handle":handle,
                        "resources":{"d1Id":d1,"currentStateId":state_current,"otherStateId":state_other,"d1Binding":input["d1Binding"]}}),
                        cancel,
                    )?;
                    checked_case(result, operation, row)
                })();
                let disposed = release(call, "mf.dispose", generation, json!({"handle":handle}));
                case_rows.push(finish_row(resource, disposed)?);
                capture::check_cancel(cancel)?;
                count += 1;
                if count > MAX_ROWS {
                    return Err("example run row limit exceeded".into());
                }
            }
            if !case_rows.is_empty() {
                cases.push(json!({"kind":"table","operation":operation,"rows":case_rows}));
            }
            Ok(())
        })();
        // testkit.dispose joins suite imports/rows before the native staging directory can disappear.
        let disposed = release(call, "testkit.dispose", generation, json!({"suite":suite}));
        if let Err(error) = disposed {
            // Preserve staging consumed by any retained late operation; parent release owns retry.
            retain_staging(generation, directory);
            return Err(format!("example suite cleanup remains owned: {error}"));
        }
        outcome?;
    }
    if count == 0 || selection.is_some() && count != 1 {
        return Err("example selected row is unavailable or ambiguous".into());
    }
    let report = completed_report(
        capture,
        generation,
        &recipe.digest,
        cases,
        count,
        call,
        cancel,
    )?;
    current(capture, inventory, cancel)?;
    let projections = match context {
        Some(context) => projections(context, run_id, &report)?,
        None => vec![],
    };
    let summary = &report["summary"];
    Ok(
        json!({"ok":summary["failed"]==0 && summary["setupFailed"]==0 && summary["unsupported"]==0,
        "executed":count,"artifactDigest":recipe.digest,"report":report,"projections":projections}),
    )
}
fn validate_report(report: &Value, digest: &str, revision: &str, expected: usize) -> Result<()> {
    if report["artifact"]["digest"] != digest
        || report["artifact"]["sourceRevision"] != revision
        || report["summary"]["total"] != expected as u64
    {
        return Err("example report identity or row count differs".into());
    }
    let mut counts = [0u64; 4];
    for case in report["cases"]
        .as_array()
        .ok_or("example report cases are absent")?
    {
        if case["kind"] != "table" {
            return Err("example report case kind differs".into());
        }
        for row in case["rows"]
            .as_array()
            .ok_or("example report rows are absent")?
        {
            let index = match row["outcome"].as_str() {
                Some("passed") => 0,
                Some("failed") => 1,
                Some("setup-failed") => 2,
                Some("unsupported") => 3,
                _ => return Err("example report outcome is invalid".into()),
            };
            counts[index] += 1;
        }
    }
    if counts.iter().sum::<u64>() != expected as u64 {
        return Err("example report actual row count differs".into());
    }
    for (key, count) in ["passed", "failed", "setupFailed", "unsupported"]
        .into_iter()
        .zip(counts)
    {
        if report["summary"][key] != count {
            return Err("example report summary differs from its rows".into());
        }
    }
    Ok(())
}

/// Owner-only bounded projections with no actor authorization: never copy values, caller, operation or raw detail.
fn projection_context(context: &Value, run: &str, report: &Value) -> Result<()> {
    for key in ["session", "revision", "servingBuild"] {
        let value = text(context, key)?;
        if value.len() > 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("example projection identity is invalid".into());
        }
    }
    let revision = text(context, "sourceRevision")?;
    let hash = revision
        .strip_prefix("sha256:")
        .ok_or("example projection source revision is invalid")?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("example projection source revision is invalid".into());
    }
    if run.is_empty()
        || run.len() > 64
        || !run
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("example projection run identity is invalid".into());
    }
    if context["sourceRevision"] != report["artifact"]["sourceRevision"] {
        return Err("example projection source mismatch".into());
    }
    Ok(())
}
pub fn projections(context: &Value, run: &str, report: &Value) -> Result<Vec<Value>> {
    projection_context(context, run, report)?;
    let mut result = Vec::new();
    for (case_index, case) in report["cases"]
        .as_array()
        .ok_or("example projection cases absent")?
        .iter()
        .enumerate()
    {
        for (entry_index, entry) in case["rows"]
            .as_array()
            .ok_or("example projection rows absent")?
            .iter()
            .enumerate()
        {
            if entry["outcome"] == "passed" {
                continue;
            }
            let mismatches = entry["mismatches"].as_array().map_or(0, Vec::len);
            let phase = match entry["outcome"].as_str() {
                Some("setup-failed") => "setup",
                Some("unsupported") => "unsupported",
                _ if entry.get("mismatches").is_some() => "assertion",
                _ => "invoke_or_observe",
            };
            let summary = match phase {
                "setup" => "Example setup failed.",
                "unsupported" => "Example could not run in this profile.",
                "assertion" => "Example assertion failed.",
                _ => "Example invocation or observation failed.",
            };
            let reference = format!(
                "{}/{}/{run}/f{case_index}_{entry_index}",
                context["session"].as_str().unwrap(),
                context["revision"].as_str().unwrap()
            );
            let absent = entry["rejection"]["sideEffectsAbsent"] == true;
            let mut missing = vec![
                "structured_example_location_unavailable",
                "trace_unavailable",
                "runtime_detail_unreleased",
                "actor_projection_unavailable",
            ];
            if mismatches > 0 {
                missing.push("actor_values_withheld");
            }
            if mismatches > 3 {
                missing.push("mismatch_values_truncated");
            }
            if !absent {
                missing.push("side_effect_scope_unproven");
            }
            let occurrence = json!({"schema":"can.dev.failure.v1","ref":reference,"session":context["session"],"revision":context["revision"],
                "source_revision":context["sourceRevision"],"serving_build":context["servingBuild"],"origin":"example","phase":phase,"summary":summary,
                "owner_ref":{"run_id":run,"case_index":case_index,"entry_index":entry_index,"row_index":entry["rowIndex"]},
                "evidence":{"state":"partial","missing":missing},"detail_ref":format!("{reference}/detail")});
            let mut detail = json!({"ref":reference,"outcome":entry["outcome"],"artifact_digest":report["artifact"]["digest"],"mismatch_count":mismatches});
            if absent {
                detail["side_effects_absent"] = json!(true);
            }
            result.push(json!({"occurrence":occurrence,"detail":detail}));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{CaptureRequest, Inventory, NamedInputPath};
    use std::{cell::RefCell, collections::BTreeMap, fs};
    fn fixture() -> (tempfile::TempDir, Capture, Value) {
        let root = tempfile::tempdir().unwrap();
        for (name, value) in [
            ("app.can", "app Probe\nGiven\nWhen\nThen\n"),
            ("compiler", "compiler"),
            ("catalog", "catalog"),
            ("help", "help"),
            ("runtime", "runtime"),
        ] {
            fs::write(root.path().join(name), value).unwrap();
        }
        let request = CaptureRequest {
            checkout_root: root.path().to_str().unwrap().into(),
            app_path: "app.can".into(),
            profile: "first".into(),
            compiler_path: "compiler".into(),
            catalog_path: Some("catalog".into()),
            help_index_path: "help".into(),
            package_input_paths: vec![NamedInputPath {
                name: "runtime".into(),
                path: "runtime".into(),
            }],
            extra_input_paths: vec![],
            semantic_options: BTreeMap::new(),
            input_inventory: None,
        };
        let captured = capture::capture(
            &request,
            &|| Ok(Inventory::default()),
            &AtomicBool::new(false),
        )
        .unwrap();
        let artifact = json!({"artifact_version":1,"modules":[{"path":"app.js","js":"export const appDefinition={id:'Probe'};","map":{}}],
            "tests":[{"scope":"Probe.check","fixtures":[],"module":{"path":"tests/check.js","js":"export function exampleFixtures(){}","map":{}}}]});
        let recipe = json!({"artifactBytes":STANDARD.encode(serde_json::to_vec(&artifact).unwrap()),"artifactLabel":"Probe.artifact.json","sourceRevision":captured.source_revision,
            "workerName":"example","compatibilityDate":"2026-07-15","d1Binding":"DB","worker":{"mainModule":"main.js","modules":{"main.js":"export default {fetch(){return new Response('ok')}}"},"binaryModules":{}}});
        (root, captured, recipe)
    }
    #[test]
    fn exact_recipe_inventory_rejects_paths_collisions_bytes_and_source_substitution() {
        let (_root, capture, mut input) = fixture();
        assert!(recipe(&input, &capture.source_revision).is_ok());
        assert!(recipe(&input, "other-source").is_err());
        input["artifactBytes"] = json!("AA=A");
        assert!(recipe(&input, &capture.source_revision).is_err());
        for path in ["../app.js", "/app.js", "app.js"] {
            let mut artifact = json!({"artifact_version":1,"modules":[{"path":"app.js","js":"source","map":{}}],"tests":[{"scope":"Probe.check","fixtures":[],"module":{"path":path,"js":"source","map":{}}}]});
            input["artifactBytes"] = json!(STANDARD.encode(serde_json::to_vec(&artifact).unwrap()));
            assert!(recipe(&input, &capture.source_revision).is_err());
            artifact["tests"][0]["module"]["path"] = json!("tests/check.js");
            input["artifactBytes"] = json!(STANDARD.encode(serde_json::to_vec(&artifact).unwrap()));
            assert!(recipe(&input, &capture.source_revision).is_ok());
        }
    }
    #[test]
    fn row_inventory_closes_exact_selection_and_rejects_duplicates_or_missing_rows() {
        let test = json!({"scope":"Probe.check","fixtures":[]});
        assert_eq!(
            rows(
                &json!({"rows":[{"rowIndex":0},{"rowIndex":3}]}),
                &test,
                Some(("Probe.check", 3))
            )
            .unwrap(),
            vec![3]
        );
        assert!(
            rows(
                &json!({"rows":[{"rowIndex":0},{"rowIndex":0}]}),
                &test,
                None
            )
            .is_err()
        );
        assert!(rows(&json!({"rows":[]}), &test, None).is_err());
        assert!(
            rows(
                &json!({"rows":[{"rowIndex":0}]}),
                &test,
                Some(("Probe.check", 3))
            )
            .is_err()
        );
        assert!(
            rows(
                &json!({"rows":[]}),
                &json!({"scope":"Probe.fixture","fixtures":["Probe.fixture"]}),
                None
            )
            .unwrap()
            .is_empty()
        );
    }
    fn report(payload: &Value) -> Value {
        let count = payload["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["rows"].as_array().unwrap().len())
            .sum::<usize>();
        json!({"artifact":{"digest":payload["artifactDigest"],"sourceRevision":payload["sourceRevision"]},"cases":payload["cases"],"summary":{"total":count,"passed":count,"failed":0,"setupFailed":0,"unsupported":0}})
    }
    #[test]
    fn native_loop_assigns_fresh_resources_and_joins_each_release_before_next_row() {
        let (_root, capture, input) = fixture();
        let events = RefCell::new(Vec::new());
        let ids = RefCell::new(BTreeSet::new());
        let call = |command: &str,
                    generation: Option<&str>,
                    payload: Value,
                    _: &AtomicBool|
         -> Result<Value> {
            assert_eq!(generation, Some("parent"));
            events.borrow_mut().push(command.to_string());
            match command {
                "testkit.load" => Ok(json!({"rows":[{"rowIndex":0},{"rowIndex":1}]})),
                "mf.create" => {
                    let worker = &payload["options"]["workers"][1];
                    for id in worker["d1Databases"].as_object().unwrap().values() {
                        assert!(ids.borrow_mut().insert(id.as_str().unwrap().to_owned()));
                    }
                    Ok(json!({"origin":"http://127.0.0.1:1"}))
                }
                "testkit.row" => Ok(
                    json!({"kind":"table","operation":"Probe.check","rows":[{"rowIndex":payload["row"],"outcome":"passed"}]}),
                ),
                "testkit.report" => Ok(report(&payload)),
                "mf.dispose" | "testkit.dispose" => Ok(json!({"released":true})),
                _ => panic!("unexpected primitive {command}"),
            }
        };
        let result = run(
            &input,
            &capture,
            "parent",
            "run-1",
            None,
            None,
            &|| Ok(Inventory::default()),
            &call,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result["executed"], 2);
        assert_eq!(ids.borrow().len(), 6);
        assert_eq!(
            *events.borrow(),
            [
                "testkit.load",
                "mf.create",
                "testkit.row",
                "mf.dispose",
                "mf.create",
                "testkit.row",
                "mf.dispose",
                "testkit.dispose",
                "testkit.report"
            ]
        );
    }
    #[test]
    fn cancellation_still_releases_row_and_suite_and_refuses_report() {
        let (_root, capture, input) = fixture();
        let cancel = AtomicBool::new(false);
        let events = RefCell::new(Vec::new());
        let call = |command: &str,
                    _: Option<&str>,
                    _: Value,
                    request_cancel: &AtomicBool|
         -> Result<Value> {
            events.borrow_mut().push(command.to_string());
            match command {
                "testkit.load" => Ok(json!({"rows":[{"rowIndex":0}]})),
                "mf.create" => Ok(json!({})),
                "testkit.row" => {
                    cancel.store(true, std::sync::atomic::Ordering::Release);
                    Err("cancelled".into())
                }
                "mf.dispose" | "testkit.dispose" => {
                    assert!(!request_cancel.load(std::sync::atomic::Ordering::Acquire));
                    Ok(json!({"released":true}))
                }
                _ => panic!("unexpected {command}"),
            }
        };
        assert!(
            run(
                &input,
                &capture,
                "parent",
                "run-1",
                None,
                None,
                &|| Ok(Inventory::default()),
                &call,
                &cancel
            )
            .is_err()
        );
        assert_eq!(
            *events.borrow(),
            [
                "testkit.load",
                "mf.create",
                "testkit.row",
                "mf.dispose",
                "testkit.dispose"
            ]
        );
    }
    #[test]
    fn safe_projection_never_releases_operation_actor_values_or_raw_runtime_detail() {
        let revision = format!("sha256:{}", "a".repeat(64));
        let context = json!({"session":"session","revision":"r1","sourceRevision":revision,"servingBuild":"b1"});
        let report = json!({"artifact":{"digest":"digest","sourceRevision":revision},"cases":[{"kind":"table","operation":"private.operation","rows":[{"rowIndex":2,"outcome":"failed","caller":{"account":"private-account"},"detail":"private-runtime","mismatches":[{"expected":"secret","actual":"other"}],"rejection":{"error":"forbidden","sideEffectsAbsent":true}}]}]});
        let projected = projections(&context, "run-1", &report).unwrap();
        let serialized = serde_json::to_string(&projected).unwrap();
        for secret in [
            "private.operation",
            "private-account",
            "private-runtime",
            "secret",
            "other",
        ] {
            assert!(!serialized.contains(secret));
        }
        assert_eq!(projected[0]["occurrence"]["phase"], "assertion");
        assert_eq!(projected[0]["detail"]["side_effects_absent"], true);
        assert_eq!(projected[0]["occurrence"]["ref"], "session/r1/run-1/f0_0");
    }
}
