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
