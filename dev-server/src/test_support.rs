//! Fixed private DTO handoff for existing semantic tests and saved-generation
//! CLI consumers. All decisions execute in the defining native modules.
use crate::{
    capture::{self, Capture, CaptureRequest, GeneratedClosure, Inventory, NamedInputPath},
    compiler, construct, inventory, preview, qualification,
    runtime::Bridge,
    sdk,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, String>;
const MAX_INPUT: u64 = 64 * 1024 * 1024;
pub fn run() -> u8 {
    crate::signals::install();
    let cancel = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let done = finished.clone();
    let watcher = thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            if crate::signals::take() {
                signal.store(true, Ordering::Release);
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    let result = (|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(MAX_INPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err("native DTO request exceeds limit".into());
        }
        let request: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        perform(&request, &cancel)
    })();
    finished.store(true, Ordering::Release);
    let _ = watcher.join();
    match result {
        Ok(value) => {
            println!("{}", json!({"ok":true,"result":value}));
            0
        }
        Err(error) => {
            println!("{}", json!({"ok":false,"detail":error}));
            1
        }
    }
}
fn text(v: &Value) -> Result<&str> {
    v.as_str().ok_or("native DTO string is required".into())
}
fn decode<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}
fn encode<T: serde::Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}
fn synthetic(
    root: &str,
    app: &str,
    compiler: Option<&str>,
    cancel: &AtomicBool,
) -> Result<Capture> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let app = fs::canonicalize(root.join(app)).map_err(|e| e.to_string())?;
    let source = fs::read(&app).map_err(|e| e.to_string())?;
    if source.len() > u32::MAX as usize {
        return Err("source exceeds compiler offset range".into());
    }
    let root = root.to_str().ok_or("root is not UTF-8")?;
    let path = app.to_str().ok_or("app is not UTF-8")?;
    let operand = app
        .strip_prefix(root)
        .map_err(|_| "app escapes root")?
        .to_str()
        .ok_or("operand is not UTF-8")?;
    Ok(Capture {
        requested_root: root.into(),
        root: root.into(),
        requested_app_path: path.into(),
        app_path: path.into(),
        compiler_operand: operand.into(),
        source_text: String::from_utf8(source.clone()).map_err(|e| e.to_string())?,
        source_sha256: capture::hash(&source),
        source_bytes: source.len() as u64,
        source_revision: String::new(),
        epoch_material: String::new(),
        profile: "local-d1-identity".into(),
        semantic_options: BTreeMap::new(),
        inputs: compiler
            .map(|c| capture::read_input(root, "compiler".into(), Some(c.into()), cancel))
            .transpose()?
            .into_iter()
            .collect(),
        input_inventory: None,
        generated_closure: None,
        source_snapshot: None,
    })
}
fn declared(capture: &Capture) -> Inventory {
    let paths = |prefix: &str| {
        capture
            .inputs
            .iter()
            .filter_map(|i| {
                Some(NamedInputPath {
                    name: i.name.strip_prefix(prefix)?.into(),
                    path: i.requested_path.clone()?,
                })
            })
            .collect()
    };
    Inventory {
        package_input_paths: paths("package:"),
        extra_input_paths: paths("extra:"),
    }
}
fn perform(request: &Value, cancel: &AtomicBool) -> Result<Value> {
    let operation = text(&request["operation"])?;
    let input = &request["input"];
    match operation {
        "admit" => {
            return Ok(
                match compiler::admit_single_app_profile(text(&input["source"])?) {
                    Ok(()) => json!({"ok":true}),
                    Err(reason) => json!({"ok":false,"reason":reason}),
                },
            );
        }
        "verify" => {
            let capture: Capture = decode(&input["capture"])?;
            return Ok(
                match capture::verify_compiler_sources(
                    &capture,
                    &input["report"],
                    input["report"]["complete"] == true,
                ) {
                    Ok(()) => json!({"ok":true}),
                    Err(reason) => json!({"ok":false,"reason":reason}),
                },
            );
        }
        "inputs" => {
            let root = text(&input["root"])?;
            let mut values = Vec::new();
            for path in input["paths"].as_array().ok_or("input paths are absent")? {
                values.push(capture::read_input(
                    root,
                    text(&path["name"])?.into(),
                    path["path"].as_str().map(str::to_owned),
                    cancel,
                )?);
            }
            return encode(values);
        }
        "discover" => {
            let capture = synthetic(
                text(&input["root"])?,
                text(&input["app"])?,
                Some(text(&input["compiler"])?),
                cancel,
            )?;
            return encode(capture::discover_generated(&capture, cancel)?);
        }
        "snapshot" => {
            let capture = synthetic(text(&input["root"])?, text(&input["app"])?, None, cancel)?;
            let closure: GeneratedClosure = decode(&input["closure"])?;
            return encode(capture::snapshot_generated(&capture, &closure, cancel)?);
        }
        _ => {}
    }
    let capture: Option<Capture> = input.get("capture").map(decode).transpose()?;
    let capture_request: Option<CaptureRequest> = if operation == "capture" {
        Some(decode(&input["request"])?)
    } else {
        None
    };
    let root = capture
        .as_ref()
        .map(|c| c.root.as_str())
        .or_else(|| capture_request.as_ref().map(|c| c.checkout_root.as_str()))
        .or_else(|| input["root"].as_str())
        .ok_or("native DTO root is absent")?;
    let compiler = capture
        .as_ref()
        .and_then(|c| {
            c.inputs
                .iter()
                .find(|i| i.name == "compiler")
                .and_then(|i| i.requested_path.as_deref())
        })
        .or_else(|| capture_request.as_ref().map(|c| c.compiler_path.as_str()))
        .or_else(|| input["compiler"].as_str())
        .ok_or("native DTO compiler is absent")?;
    let catalog = capture
        .as_ref()
        .and_then(|c| {
            c.inputs
                .iter()
                .find(|i| i.name == "catalog")
                .and_then(|i| i.requested_path.as_deref())
        })
        .or_else(|| {
            capture_request
                .as_ref()
                .and_then(|c| c.catalog_path.as_deref())
        })
        .or_else(|| input["catalog"].as_str());
    let installed = matches!(operation, "inventory" | "prepare")
        || capture
            .as_ref()
            .is_some_and(|c| c.input_inventory.is_some())
        || capture_request
            .as_ref()
            .is_some_and(|c| c.input_inventory.is_some());
    if !installed {
        let inventory = || {
            Ok(capture.as_ref().map(declared).unwrap_or_else(|| Inventory {
                package_input_paths: capture_request
                    .as_ref()
                    .map(|c| c.package_input_paths.clone())
                    .unwrap_or_default(),
                extra_input_paths: capture_request
                    .as_ref()
                    .map(|c| c.extra_input_paths.clone())
                    .unwrap_or_default(),
            }))
        };
        return execute(
            operation,
            input,
            capture.as_ref(),
            capture_request.as_ref(),
            &inventory,
            cancel,
        );
    }
    let config = crate::app::helper_bridge(
        Path::new(root),
        format!("native-dto-{}", preview::random_id()?),
    )
    .map_err(|e| e.to_string())?;
    let bridge = Bridge::spawn(config).map_err(|e| e.to_string())?;
    let resources = sdk::Resources::default();
    let result = (|| {
        let call = |command: &str, parent: Option<&str>, payload: Value, signal: &AtomicBool| {
            sdk::call(&bridge, &resources, command, parent, payload, signal)
        };
        let inventory = || {
            inventory::collect(
                Path::new(root),
                Path::new(compiler),
                Path::new(catalog.ok_or("native DTO catalog absent")?),
                &call,
                cancel,
            )
        };
        if operation == "inventory" {
            return encode(inventory()?);
        }
        if operation == "prepare" {
            let inventory = inventory()?;
            return encode(CaptureRequest {
                checkout_root: root.into(),
                app_path: text(&input["app"])?.into(),
                profile: "local-d1-identity".into(),
                compiler_path: compiler.into(),
                catalog_path: catalog.map(str::to_owned),
                help_index_path: text(&input["help"])?.into(),
                package_input_paths: inventory.package_input_paths,
                extra_input_paths: inventory.extra_input_paths,
                semantic_options: input
                    .get("semanticOptions")
                    .map(decode)
                    .transpose()?
                    .unwrap_or_default(),
                input_inventory: Some("installed-local-preview".into()),
            });
        }
        if operation == "qualify" {
            let capture = capture.as_ref().ok_or("capture DTO absent")?;
            let index = construct::run(capture, &json!({"action":"index"}), cancel)?;
            let parent = format!("native-qualification-{}", preview::random_id()?);
            let result = qualification::run(
                capture,
                &index["request"],
                &parent,
                &call,
                &inventory,
                cancel,
            );
            sdk::release(&bridge, &resources, &parent)?;
            return result;
        }
        execute(
            operation,
            input,
            capture.as_ref(),
            capture_request.as_ref(),
            &inventory,
            cancel,
        )
    })();
    bridge
        .shutdown(Instant::now() + Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    resources.host_released()?;
    result
}
fn execute(
    operation: &str,
    _input: &Value,
    capture: Option<&Capture>,
    request: Option<&CaptureRequest>,
    inventory: &capture::InventoryProvider<'_>,
    cancel: &AtomicBool,
) -> Result<Value> {
    if operation == "capture" {
        return encode(capture::capture(
            request.ok_or("capture request absent")?,
            inventory,
            cancel,
        )?);
    }
    let capture = capture.ok_or("capture DTO absent")?;
    match operation {
        "current" => Ok(json!(capture::is_current(capture, inventory, cancel))),
        "producer-current" => Ok(json!(capture::producer_inputs_current(
            capture, inventory, cancel
        ))),
        "runtime-current" => Ok(json!(capture::runtime_inputs_current(
            capture, inventory, cancel
        ))),
        "compile" => encode(compiler::compile(capture, inventory, cancel, &|_| {})),
        _ => Err("unknown fixed native DTO operation".into()),
    }
}
