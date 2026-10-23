use super::{Result, state::compact_json};
use crate::capture::hash;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::collections::BTreeMap;
pub fn bytes(value: &Value) -> Result<Vec<u8>> {
    if let Some(text) = value.as_str() {
        return STANDARD.decode(text).map_err(|e| e.to_string());
    }
    let array = value
        .as_array()
        .or_else(|| value["data"].as_array())
        .ok_or("bundle bytes must be an array")?;
    array
        .iter()
        .map(|n| {
            n.as_u64()
                .filter(|n| *n <= 255)
                .map(|n| n as u8)
                .ok_or("invalid bundle byte".into())
        })
        .collect()
}
pub fn verify(artifact_json: &str, reply: &Value) -> Result<Value> {
    let b = &reply["bundle"];
    let modules = b["modules"]
        .as_object()
        .ok_or("BUNDLE_INVALID: missing module map")?;
    let binaries = b["binaries"]
        .as_object()
        .ok_or("BUNDLE_INVALID: missing binary map")?;
    let resources = b["resources"]
        .as_object()
        .ok_or("RESOURCE_INVALID: missing browser resource map")?;
    verify_module_sources(b, modules)?;
    verify_mixed_modules(b, modules, binaries)?;
    let staged = checked_staged_artifact(artifact_json, modules)?;
    verify_browser_resources(b, reply, resources, staged)?;
    // Ensure the serialized artifact is the same parse tree even when the source
    // compiler formatted its JSON; object order remains available separately.
    let _: Value =
        serde_json::from_str(&compact_json(artifact_json)?).map_err(|e| e.to_string())?;
    Ok(b.clone())
}
fn verify_module_sources(b: &Value, modules: &serde_json::Map<String, Value>) -> Result<()> {
    if b["mainModule"] != "worker/main.js"
        || b["moduleCount"].as_u64() != Some(modules.len() as u64)
        || [
            "worker/main.js",
            "worker/artifact.js",
            "worker/http-assets.js",
            "worker/mcp-handler.js",
            "worker/http-operations.js",
        ]
        .iter()
        .any(|k| !modules.get(*k).is_some_and(Value::is_string))
    {
        return Err("BUNDLE_INVALID: portable bundle lacks required Worker modules".into());
    }
    let sorted: BTreeMap<_, _> = modules
        .iter()
        .map(|(k, v)| v.as_str().map(|v| (k, v)).ok_or("invalid module source"))
        .collect::<std::result::Result<_, _>>()?;
    // Typed tuples retain the original Node digest field order.
    let module_json = format!(
        "{{\"mainModule\":\"worker/main.js\",\"modules\":{}}}",
        serde_json::to_string(&sorted).unwrap()
    );
    if b["sha256"].as_str() != Some(&hash(module_json.as_bytes())) {
        return Err("BUNDLE_INTEGRITY: module digest mismatch".into());
    }
    for (key, field) in [
        ("worker/mcp-handler.js", "mcpBundleBytes"),
        ("worker/http-operations.js", "httpOperationsBytes"),
    ] {
        let source = modules[key].as_str().unwrap();
        if source.is_empty() || b[field].as_u64() != Some(source.encode_utf16().count() as u64) {
            return Err("BUNDLE_INTEGRITY: module size mismatch".into());
        }
    }
    Ok(())
}
fn verify_mixed_modules(
    b: &Value,
    modules: &serde_json::Map<String, Value>,
    binaries: &serde_json::Map<String, Value>,
) -> Result<()> {
    let mut mixed = vec![];
    mixed.extend_from_slice(&(14u32).to_be_bytes());
    mixed.extend_from_slice(b"worker/main.js");
    let mut assets: BTreeMap<String, (u8, Vec<u8>)> = BTreeMap::new();
    for (k, v) in modules {
        if k.is_empty() || k == "__proto__" {
            return Err("invalid bundle module key".into());
        }
        assets.insert(
            k.clone(),
            (
                1,
                v.as_str()
                    .ok_or("invalid module source")?
                    .as_bytes()
                    .to_vec(),
            ),
        );
    }
    for (k, v) in binaries {
        if k.is_empty() || k == "__proto__" || assets.contains_key(k) {
            return Err("invalid or colliding binary key".into());
        }
        assets.insert(k.clone(), (2, bytes(v)?));
    }
    for (key, (kind, raw)) in assets {
        mixed.extend_from_slice(&(key.len() as u32).to_be_bytes());
        mixed.extend_from_slice(key.as_bytes());
        mixed.push(kind);
        mixed.extend_from_slice(&(raw.len() as u64).to_be_bytes());
        mixed.extend_from_slice(&raw);
    }
    if b["mixedSha256"].as_str() != Some(&hash(&mixed)) {
        return Err("BUNDLE_INTEGRITY: mixed module digest mismatch".into());
    }
    Ok(())
}
fn checked_staged_artifact<'a>(
    artifact_json: &str,
    modules: &'a serde_json::Map<String, Value>,
) -> Result<&'a str> {
    let staged = modules["worker/artifact.js"].as_str().unwrap();
    if !staged
        .lines()
        .any(|line| line == format!("export const artifact = {artifact_json};"))
        || !staged
            .lines()
            .any(|line| line == "export const verdict = {\"active\":true};")
    {
        return Err("BUNDLE_ARTIFACT_MISMATCH: staged artifact or verdict differs".into());
    }
    Ok(staged)
}
fn verify_browser_resources(
    b: &Value,
    reply: &Value,
    resources: &serde_json::Map<String, Value>,
    staged: &str,
) -> Result<()> {
    let generated = reply["generatedResources"]
        .as_object()
        .ok_or("generated style resource map missing")?;
    let mut expected: Vec<_> = vec![
        "browser/bootstrap.js",
        "browser/can-style.css",
        "browser/polling.js",
    ]
    .into_iter()
    .map(str::to_string)
    .chain(generated.keys().cloned())
    .collect();
    expected.sort();
    let actual: Vec<_> = resources.keys().cloned().collect();
    if actual != expected {
        return Err("RESOURCE_INVALID: resource inventory differs".into());
    }
    let mut rows = vec![];
    for (key, resource) in resources {
        let raw = bytes(&resource["bytes"])?;
        let content_type = resource["contentType"]
            .as_str()
            .ok_or("invalid browser content type")?;
        if let Some(generated) = generated.get(key) {
            if generated["contentType"] != resource["contentType"]
                || bytes(&generated["bytes"])? != raw
            {
                return Err("RESOURCE_INVALID: generated stylesheet bytes differ".into());
            }
        } else if raw.is_empty()
            || content_type
                != if key.ends_with(".css") {
                    "text/css"
                } else {
                    "application/javascript"
                }
        {
            return Err("RESOURCE_INVALID: packaged browser bytes invalid".into());
        }
        rows.push(format!(
            "{{\"key\":{},\"contentType\":{},\"bytes\":{},\"sha256\":{}}}",
            serde_json::to_string(key).unwrap(),
            serde_json::to_string(content_type).unwrap(),
            raw.len(),
            serde_json::to_string(&hash(&raw)).unwrap()
        ));
    }
    let digest = hash(format!("{{\"version\":1,\"resources\":[{}]}}", rows.join(",")).as_bytes());
    if b["resourcesSha256"].as_str() != Some(&digest)
        || !staged.contains(&format!("\"resourcesSha256\":\"{digest}\""))
    {
        return Err("RESOURCE_INVALID: browser resource digest mismatch".into());
    }
    Ok(())
}
