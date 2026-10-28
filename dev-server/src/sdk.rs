//! Native ownership of SDK input files and temporary trees. A timed-out wait
//! retains its inputs until the operation joins or the host group is released.
use crate::{
    files::{self, FileRef, Payloads},
    runtime::{Allocation, Bridge},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
#[derive(Default)]
pub struct Resources {
    inputs: Mutex<BTreeMap<String, (Option<String>, Payloads)>>,
    paths: Mutex<BTreeMap<String, Vec<PathBuf>>>,
    retired: Mutex<VecDeque<String>>,
}
static SERIAL: AtomicU64 = AtomicU64::new(0);
fn id() -> String {
    format!("sdk-{}", SERIAL.fetch_add(1, Ordering::Relaxed))
}
impl Resources {
    pub fn released(&self, parent: &str) -> Result<(), String> {
        let paths = self
            .paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(parent)
            .cloned()
            .unwrap_or_default();
        for path in paths {
            match std::fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
                Ok(metadata) => {
                    use std::os::unix::fs::MetadataExt;
                    if !metadata.is_dir()
                        || metadata.uid() != unsafe { libc::getuid() }
                        || metadata.mode() & 0o077 != 0
                        || std::fs::canonicalize(&path).map_err(|e| e.to_string())? != path
                    {
                        return Err("temporary SDK tree identity changed".into());
                    }
                    std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
                }
            }
        }
        self.paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(parent);
        let mut retired = self.retired.lock().unwrap_or_else(|e| e.into_inner());
        if !retired.iter().any(|p| p == parent) {
            retired.push_back(parent.into());
        }
        while retired.len() > 256 {
            retired.pop_front();
        }
        self.inputs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, (scope, _)| scope.as_deref() != Some(parent));
        crate::examples::release_staging(parent);
        Ok(())
    }
    pub fn retired(&self, parent: &str) -> bool {
        self.retired
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|p| p == parent)
    }
    pub fn owns(&self, parent: &str) -> bool {
        self.paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(parent)
    }
    pub fn host_released(&self) -> Result<(), String> {
        let parents: Vec<_> = self
            .paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        for parent in parents {
            self.released(&parent)?;
        }
        self.inputs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        Ok(())
    }
    fn paths(&self, parent: Option<&str>, payload: &Value) -> Result<Value, String> {
        let parent = parent.ok_or("temporary SDK tree needs a native parent")?;
        if let Some(path) = payload["temporary"].as_str() {
            let path = PathBuf::from(path);
            let temp = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
            let directory = path.parent().ok_or("temporary tree has no parent")?;
            let directory = std::fs::canonicalize(directory).map_err(|e| e.to_string())?;
            if directory != temp
                || !path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("can-"))
            {
                return Err("SDK tree must be native private temporary allocation".into());
            }
            let path = directory.join(path.file_name().unwrap());
            let mut paths = self.paths.lock().unwrap_or_else(|e| e.into_inner());
            let owned = paths.entry(parent.into()).or_default();
            if !owned.contains(&path) {
                if owned.len() >= 256 {
                    return Err("SDK temporary tree limit".into());
                }
                owned.push(path);
            }
        }
        Ok(json!({"registered":true}))
    }
}
pub fn call(
    bridge: &Bridge,
    resources: &Resources,
    command: &str,
    parent: Option<&str>,
    payload: Value,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    if command == "resource.paths" {
        return resources.paths(parent, &payload);
    }
    if let Some(parent) = parent {
        resources
            .paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(parent.into())
            .or_default();
    }
    let operation = id();
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let payload = if bytes.len() > 24 * 1024 {
        let mut files = Payloads::new()?;
        let reference = files.write(&bytes)?;
        resources
            .inputs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(operation.clone(), (parent.map(str::to_owned), files));
        json!({"input":reference})
    } else {
        payload
    };
    // Staging materializes the whole preview dataset in one retained
    // operation; large apps exceed the interactive deadline, so staging
    // alone gets a longer join. Every other command keeps 60s.
    let deadline_secs = if command == "testkit.stage" { 600 } else { 60 };
    let response = match bridge.request(
        command,
        &operation,
        parent,
        payload,
        Instant::now() + Duration::from_secs(deadline_secs),
        cancel,
    ) {
        Ok(response) => response,
        Err(error) => {
            let joined = bridge.request(
                "cancel",
                &id(),
                parent,
                json!({"operationId":operation}),
                Instant::now() + Duration::from_secs(5),
                &AtomicBool::new(false),
            );
            if !joined.is_ok_and(|r| r.ok && r.allocation != Allocation::ReleaseFailed) {
                return Err("CLEANUP_REQUIRED: SDK operation join is unconfirmed".into());
            }
            resources
                .inputs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&operation);
            return Err(error.to_string());
        }
    };
    resources
        .inputs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&operation);
    if response.allocation == Allocation::ReleaseFailed {
        return Err("CLEANUP_REQUIRED: SDK resources remain owned".into());
    }
    if !response.ok {
        return Err(response
            .error
            .map(|e| format!("{}: {}", e.code, e.message))
            .unwrap_or_else(|| "SDK operation failed".into()));
    }
    let result = response.result.unwrap_or(Value::Null);
    if let Some(reference) = result.get("output") {
        let reference: FileRef =
            serde_json::from_value(reference.clone()).map_err(|e| e.to_string())?;
        let parsed = serde_json::from_slice(&files::read(&reference)?).map_err(|e| e.to_string());
        let consumed = bridge
            .request(
                "consume",
                &id(),
                parent,
                json!({"files":[reference]}),
                Instant::now() + Duration::from_secs(2),
                &AtomicBool::new(false),
            )
            .map_err(|e| e.to_string())?;
        if !consumed.ok {
            return Err("SDK output consumption failed".into());
        }
        parsed
    } else {
        Ok(result)
    }
}
pub fn release(bridge: &Bridge, resources: &Resources, parent: &str) -> Result<(), String> {
    let response = bridge
        .request(
            "release",
            &id(),
            Some(parent),
            json!({}),
            Instant::now() + Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .map_err(|e| e.to_string())?;
    if !response.ok || response.allocation != Allocation::Released {
        return Err("CLEANUP_REQUIRED: SDK parent release remains incomplete".into());
    }
    resources.released(parent)
}
