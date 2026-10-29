//! JSON-only Miniflare option construction; JS supplies SDK object entry points.
use super::{
    Result,
    bindings::{Plan, resource_id},
    bundle::bytes,
    random_id, random_secret,
    state::create_private_directory,
};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, path::Path};
pub fn bindings(plan: &Plan, persistence: &str, preflight: bool) -> Result<Value> {
    let mut worker = json!({"r2Buckets":{},"kvNamespaces":{},"durableObjects":{},"queueProducers":{},"queueConsumers":{},"bindings":{}});
    let mut queue = Map::new();
    for b in &plan.bindings {
        let key = b["binding"].as_str().unwrap();
        let id = resource_id(key);
        match b["kind"].as_str().unwrap() {
            "r2" => worker["r2Buckets"][key] = json!(id),
            "kv" => worker["kvNamespaces"][key] = json!(id),
            "durable-object" if !preflight => {
                worker["durableObjects"][key] =
                    json!({"className":"CanRootAuthority","useSQLite":true})
            }
            "queue" => {
                worker["queueProducers"][key] = json!(id);
                if !preflight && !b["handlers"].as_array().unwrap().is_empty() {
                    worker["queueConsumers"][&id] = json!({"maxBatchSize":1,"maxBatchTimeout":0});
                }
                queue.insert(id, json!(key));
            }
            // Service bindings have no preview provider: the worker boots
            // without them and sends fail loud at invoke through the
            // dispatch unavailable verdict naming the target. Staging a
            // fake provider or synthetic completions would be dishonest;
            // refusing the whole preview would gate local development on
            // every deployment capability the app touches.
            "service" => {}
            _ => {}
        }
    }
    if !queue.is_empty() {
        worker["bindings"]["CAN_LOCAL_QUEUE_BINDINGS"] = Value::Object(queue);
    }
    let _ = persistence;
    Ok(worker)
}
pub fn modules(main: &str, modules: &Value, binaries: &Value) -> Result<Value> {
    let modules = modules.as_object().ok_or("module map missing")?;
    if !modules.contains_key(main) {
        return Err("main Worker module missing".into());
    }
    let mut result = vec![json!({"path":main,"type":"ESModule","contents":modules[main]})];
    for (key, value) in modules {
        if key != main {
            if !value.is_string() {
                return Err("module source must be text".into());
            }
            result.push(json!({"path":key,"type":"ESModule","contents":value}));
        }
    }
    if let Some(binaries) = binaries.as_object() {
        for (key, value) in binaries {
            if modules.contains_key(key) {
                return Err("binary module collides with text module".into());
            }
            result.push(json!({"path":key,"type":"CompiledWasm","contents":bytes(value)?}));
        }
    }
    Ok(json!(result))
}
pub fn options(
    handle: &str,
    worker_name: &str,
    mut worker: Value,
    plan: &Plan,
    persistence: Option<&str>,
    preflight: bool,
) -> Result<(Value, String)> {
    let secret = random_secret(32)?;
    worker["name"] = json!(worker_name);
    worker["compatibilityDate"] = json!(super::COMPATIBILITY_DATE);
    worker["compatibilityFlags"] = json!([]);
    let analytics_name = format!("can-local-analytics-{}", random_id()?);
    let mut datasets = BTreeSet::new();
    for binding in plan
        .bindings
        .iter()
        .filter(|b| b["kind"] == "analytics-engine")
    {
        let dataset = resource_id(binding["binding"].as_str().unwrap());
        worker["wrappedBindings"][binding["binding"].as_str().unwrap()] = json!({"scriptName":analytics_name,"bindings":{"dataset":dataset,"workerName":worker_name}});
        datasets.insert(dataset);
    }
    let gateway = json!({"name":format!("can-local-gateway-{}",random_id()?),"compatibilityDate":super::COMPATIBILITY_DATE,"modules":true,"script":include_str!("gateway.js"),"bindings":{"CAN_LOCAL_SECRET":secret},"serviceBindings":{"CAN_LOCAL_APP":worker_name}});
    let mut workers = vec![gateway, worker];
    if !datasets.is_empty() {
        workers.push(json!({"name":analytics_name,"modules":[{"type":"ESModule","path":"analytics.js","contents":include_str!("analytics.js")}],"serviceBindings":{}}));
    }
    let mut options = json!({"cf":false,"host":"127.0.0.1","port":0,"workers":workers});
    if let Some(persistence) = persistence {
        options["d1Persist"] = json!(persistence);
        for (kind, key, subdir) in [
            ("r2", "r2Persist", "r2"),
            ("kv", "kvPersist", "kv"),
            ("durable-object", "durableObjectsPersist", "durable-objects"),
        ] {
            if plan.bindings.iter().any(|b| b["kind"] == kind)
                && !(preflight && kind == "durable-object")
            {
                let path = Path::new(persistence).join(subdir);
                create_private_directory(&path)?;
                options[key] = json!(path);
            }
        }
    }
    let mut temporary_paths = Vec::new();
    let analytics = if datasets.is_empty() {
        Value::Null
    } else {
        let path = if let Some(persistence) = persistence {
            Path::new(persistence).join("analytics")
        } else {
            let path = std::env::temp_dir().join(format!("can-preview-analytics-{}", random_id()?));
            temporary_paths.push(path.clone());
            path
        };
        create_private_directory(&path)?;
        let sink_paths: std::collections::BTreeMap<_, _> = datasets
            .iter()
            .map(|dataset| {
                (
                    dataset.clone(),
                    path.join(format!(
                        "{}.jsonl",
                        crate::capture::hash(dataset.as_bytes())
                    )),
                )
            })
            .collect();
        json!({"worker":analytics_name,"datasets":datasets,"workers":[worker_name],"sinkPaths":sink_paths,"maxBodyBytes":65536})
    };
    Ok((
        json!({"handle":handle,"workerName":worker_name,"secret":secret,"options":options,"analytics":analytics,"temporaryPaths":temporary_paths}),
        secret,
    ))
}
