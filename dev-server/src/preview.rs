//! Native preview admission, resource planning, retained state and readiness.
//! The bridge exposes fixed SDK/shared semantic primitives, never a preview job.
mod bindings;
mod bundle;
pub mod http;
mod runtime;
mod state;
use crate::{
    capture::{self, Capture},
    gateway::Backend,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::atomic::AtomicBool,
};
pub type Result<T> = std::result::Result<T, String>;
pub type Call<'a> = dyn Fn(&str, Option<&str>, Value, &AtomicBool) -> Result<Value> + 'a;
pub const COMPATIBILITY_DATE: &str = "2026-07-15";
pub const CAPABILITIES: &[&str] = &[
    "canlang.builtins",
    "values.decimal",
    "values.int64",
    "values.money",
    "values.temporal",
    "state",
    "state.machines",
    "state.parameters",
    "state.field-validation",
    "interfaces.input-choices",
    "cloudflare.runtime-bindings",
];
pub struct Prepared {
    pub backend: Backend,
    pub recipe: Value,
    pub actors: Value,
    pub recovery: Option<Value>,
}
pub fn random_id() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let h = b.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
fn random_secret(n: usize) -> Result<String> {
    let mut bytes = vec![0; n];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
struct Bridge<'a> {
    generation: &'a str,
    call: &'a Call<'a>,
    cancel: &'a AtomicBool,
}
impl Bridge<'_> {
    fn allocate(&self, payload: Value) -> Result<Value> {
        if let Some(paths) = payload["temporaryPaths"].as_array() {
            for path in paths {
                (self.call)(
                    "resource.paths",
                    Some(self.generation),
                    json!({"temporary":path}),
                    &AtomicBool::new(false),
                )?;
            }
        }
        self.call("mf.create", payload)
    }
    fn call(&self, command: &str, payload: Value) -> Result<Value> {
        capture::check_cancel(self.cancel)?;
        (self.call)(command, Some(self.generation), payload, self.cancel)
    }
}

struct Built {
    artifact_json: String,
    plan: bindings::Plan,
    mode: String,
    roles: BTreeMap<String, Vec<String>>,
    constants: Value,
    app: String,
    bundle: Value,
}
fn build(
    capture: &Capture,
    artifact: &Value,
    artifact_bytes: &[u8],
    preview_roles: &Value,
    bridge: &Bridge<'_>,
    delivery: bool,
) -> Result<Built> {
    admit(capture, artifact, delivery)?;
    let artifact_json = exact_artifact_json(artifact, artifact_bytes)?;
    let ast = artifact["modules"][0]["js"]
        .as_str()
        .map(|source| bridge.call("metadata.parse", json!({"source":source})))
        .transpose()?;
    let plan = bindings::plan(artifact, ast.as_ref())?;
    let mode = plan
        .no_model_storage_mode
        .clone()
        .unwrap_or(storage_mode(artifact)?);
    validate_selected_callables(artifact, &plan)?;
    // Service requirements fail before any state is allocated.
    runtime::bindings(&plan, "unused", true)?;
    let roles = parse_roles(preview_roles)?;
    let constants = runtime_constants(artifact, bridge)?;
    let app = match &plan.app {
        Some(app) => app.clone(),
        None => app_name(&capture.source_text)?,
    };
    preflight(
        capture,
        artifact,
        &artifact_json,
        &plan,
        &constants,
        &app,
        bridge,
    )?;
    let bundle = build_bundle(capture, artifact, &artifact_json, bridge)?;
    Ok(Built {
        artifact_json,
        plan,
        mode,
        roles,
        constants,
        app,
        bundle,
    })
}
fn exact_artifact_json(artifact: &Value, artifact_bytes: &[u8]) -> Result<String> {
    if artifact_bytes.is_empty() || artifact_bytes.len() > 16 * 1024 * 1024 {
        return Err("ARTIFACT_BYTES_UNAVAILABLE: exact compiler artifact unavailable".into());
    }
    let artifact_json = state::compact_json(
        std::str::from_utf8(artifact_bytes).map_err(|_| "artifact is not UTF-8")?,
    )?;
    if serde_json::from_str::<Value>(&artifact_json).map_err(|e| e.to_string())? != *artifact {
        return Err(
            "ARTIFACT_BYTES_MISMATCH: compiler artifact differs from admitted artifact".into(),
        );
    }
    Ok(artifact_json)
}

fn validate_selected_callables(artifact: &Value, plan: &bindings::Plan) -> Result<()> {
    // Native model-policy hooks are compiler-checked with sealed bindings,
    // so their handler callables are admitted without queue selection.
    let hooks: BTreeSet<&str> = artifact["modelPolicies"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .flat_map(|policy| {
            policy["hooks"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|hook| hook["id"].as_str())
        })
        .collect();
    for callable in artifact["callables"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        if callable["kind"] == "migration"
            || callable["kind"] == "handler"
                && !plan
                    .queue_handlers
                    .iter()
                    .any(|h| callable["id"] == h.as_str())
                && !callable["id"]
                    .as_str()
                    .is_some_and(|id| hooks.contains(id))
        {
            return Err(
                "PROFILE_UNSUPPORTED: only checked selected queue handlers are admitted".into(),
            );
        }
    }
    Ok(())
}

fn runtime_constants(artifact: &Value, bridge: &Bridge<'_>) -> Result<Value> {
    let constants = bridge.call("runtime.constants", json!({}))?;
    if artifact["language_version"] != "1.0"
        || artifact["tool_version"] != constants["releaseVersion"]
    {
        return Err(
            "VERSION_MISMATCH: compiled app does not match installed runtime release".into(),
        );
    }
    Ok(constants)
}

fn preflight(
    capture: &Capture,
    artifact: &Value,
    artifact_json: &str,
    plan: &bindings::Plan,
    constants: &Value,
    app: &str,
    bridge: &Bridge<'_>,
) -> Result<()> {
    let preflight_id = format!("can-preview-preflight-{}", random_id()?);
    let preflight_handle = format!("preflight-{}", random_id()?);
    let preflight_name = preflight_handle.clone();
    let mut preflight = runtime::bindings(&plan, "unused", true)?;
    preflight["modules"] = runtime::modules(
        "main.js",
        &json!({"main.js":"export default { fetch() { return new Response(null, { status: 404 }); } };"}),
        &json!({}),
    )?;
    preflight["d1Databases"] = json!({"DB":preflight_id});
    let (options, _) = runtime::options(
        &preflight_handle,
        &preflight_name,
        preflight,
        &plan,
        None,
        true,
    )?;
    bridge.allocate(options)?;
    activate(
        &bridge,
        &preflight_handle,
        &preflight_name,
        "DB",
        None,
        None,
        &preflight_id,
        &app,
        artifact,
        &artifact_json,
        capture,
        &plan,
        &constants,
    )?;
    bridge.call("mf.dispose", json!({"handle":preflight_handle}))?;
    Ok(())
}

fn build_bundle(
    capture: &Capture,
    artifact: &Value,
    artifact_json: &str,
    bridge: &Bridge<'_>,
) -> Result<Value> {
    let esbuild = capture
        .inputs
        .iter()
        .find(|i| i.name == "extra:esbuild" && i.state == "present")
        .and_then(|i| i.canonical_path.as_ref())
        .ok_or("BUNDLE_INPUTS_INCOMPLETE: captured esbuild is unavailable")?;
    let reply=bridge.call("bundle.build",json!({"artifactJson":artifact_json,"verdict":{"active":true},"assets":{"browser":true,"valuesWasm":artifact["requires"].as_array().unwrap().iter().any(|r|r["capability"].as_str().unwrap_or("").starts_with("values."))},"esbuildBinaryPath":esbuild}))?;
    let bundle = bundle::verify(&artifact_json, &reply)?;
    bridge.call("bundle.assert",json!({"modules":bundle["modules"],"binaryKeys":bundle["binaries"].as_object().unwrap().keys().collect::<Vec<_>>()}))?;
    Ok(bundle)
}

/// A saved-artifact command needs the same activation and portable bundle, without
/// opening a serving preview or borrowing its Identity/state resources.
pub fn example_recipe(
    capture: &Capture,
    artifact: &Value,
    artifact_bytes: &[u8],
    generation: &str,
    call: &Call<'_>,
    cancel: &AtomicBool,
) -> Result<Value> {
    let bridge = Bridge {
        generation,
        call,
        cancel,
    };
    let built = build(
        capture,
        artifact,
        artifact_bytes,
        &json!({}),
        &bridge,
        false,
    )?;
    let bundle = built.bundle;
    Ok(
        json!({"artifactBytes":STANDARD.encode(artifact_bytes),"artifactLabel":capture.compiler_operand,"sourceRevision":capture.source_revision,
        "worker":{"mainModule":bundle["mainModule"],"modules":bundle["modules"],"binaryModules":bundle["binaries"].as_object().ok_or("bundle binary map missing")?.iter().map(|(key,value)|Ok((key.clone(),json!(STANDARD.encode(bundle::bytes(value)?))))).collect::<Result<BTreeMap<_,_>>>()?},
        "workerName":format!("can-preview-examples-{}",random_id()?),"compatibilityDate":COMPATIBILITY_DATE,"d1Binding":"DB"}),
    )
}
pub fn default_state_root() -> Result<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("CAN_DEV_STATE_ROOT") {
        return Ok(path.into());
    }
    let home =
        std::env::var_os("HOME").ok_or("home directory unavailable for retained preview state")?;
    Ok(std::path::PathBuf::from(home).join(".local/state/canlang/preview"))
}
pub fn prepare(
    capture: &Capture,
    artifact: &Value,
    artifact_bytes: &[u8],
    generation: &str,
    origin: &str,
    persistence_root: Option<&Path>,
    preview_roles: &Value,
    call: &Call<'_>,
    cancel: &AtomicBool,
) -> Result<Prepared> {
    let bridge = Bridge {
        generation,
        call,
        cancel,
    };
    validate_preview_origin(origin)?;
    let built = build(
        capture,
        artifact,
        artifact_bytes,
        preview_roles,
        &bridge,
        true,
    )?;
    let mut retained = persistence_root
        .map(|root| state::Retained::open(root, capture, &built.artifact_json, &built.mode))
        .transpose()?;
    // A temporary tree is retained by the parent generation until all SDK
    // handles are confirmed released. The native owner removes it at release.
    let temporary = if retained.is_none() {
        let path = std::env::temp_dir().join(format!("can-preview-d1-{}", random_id()?));
        state::create_private_directory(&path)?;
        Some(path)
    } else {
        None
    };
    let persistence = retained
        .as_ref()
        .map(|r| r.persistence.clone())
        .unwrap_or_else(|| temporary.as_ref().unwrap().to_string_lossy().into());
    let database_id = retained
        .as_ref()
        .map(|r| r.database_id.clone())
        .unwrap_or(format!("can-preview-{}", random_id()?));
    // Register backing files with the generation before an SDK can consume them.
    (bridge.call)(
        "resource.paths",
        Some(generation),
        json!({"temporary":temporary}),
        &AtomicBool::new(false),
    )?;
    let seed = provision_identity(
        capture,
        &built.artifact_json,
        &built.roles,
        &mut retained,
        &persistence,
        &database_id,
        &bridge,
    )?;
    serve_preview(
        capture,
        artifact,
        artifact_bytes,
        origin,
        &persistence,
        &database_id,
        temporary,
        &mut retained,
        built,
        seed,
        &bridge,
    )
}
fn serve_preview(
    capture: &Capture,
    artifact: &Value,
    artifact_bytes: &[u8],
    origin: &str,
    persistence: &str,
    database_id: &str,
    temporary: Option<std::path::PathBuf>,
    retained: &mut Option<state::Retained>,
    built: Built,
    seed: Value,
    bridge: &Bridge<'_>,
) -> Result<Prepared> {
    let Built {
        artifact_json,
        plan,
        mode,
        constants,
        app,
        bundle,
        ..
    } = built;
    let owners = if mode == "global" {
        vec![]
    } else {
        seed["owners"].as_array().unwrap().iter().enumerate().map(|(index,o)|Ok(json!({"owner":o["owner"],"binding":o["binding"],"id":retained.as_ref().map(|r|r.owner_database_ids[index].clone()).unwrap_or(format!("can-preview-owner-{}",random_id()?))}))).collect::<Result<Vec<_>>>()?
    };
    let handle = format!("serving-{}", random_id()?);
    let worker_name = format!("can-preview-{}", random_id()?);
    let mut worker = runtime::bindings(&plan, &persistence, false)?;
    worker["modules"] =
        runtime::modules("worker/main.js", &bundle["modules"], &bundle["binaries"])?;
    worker["d1Databases"] = json!({"DB":database_id});
    for owner in &owners {
        worker["d1Databases"][owner["binding"].as_str().unwrap()] = owner["id"].clone();
    }
    worker["bindings"]["CAN_AUTH_ORIGIN"] = json!(origin);
    worker["bindings"]["CAN_DEPLOYMENT_BASE"] = json!(origin);
    worker["bindings"]["CAN_LOCAL_FILES"] = json!(true);
    worker["bindings"]["CAN_FORM_BINDING_KEY"] = json!(random_secret(32)?);
    if !owners.is_empty() {
        worker["bindings"]["CAN_STATE_OWNERS"] = json!({"version":1,"owners":owners.iter().map(|o|json!({"owner":o["owner"],"binding":o["binding"],"initializeFresh":true})).collect::<Vec<_>>()});
    }
    let (options, secret) = runtime::options(
        &handle,
        &worker_name,
        worker,
        &plan,
        Some(&persistence),
        false,
    )?;
    let created = bridge.allocate(options)?;
    let backend_value = created.get("backend").unwrap_or(&created);
    let backend = Backend {
        origin: backend_value["origin"]
            .as_str()
            .ok_or("SDK backend origin missing")?
            .into(),
        header: "x-can-local-dispatch".into(),
        secret,
        url_header: "x-can-local-url".into(),
    };
    activate_serving(
        capture,
        artifact,
        &artifact_json,
        &owners,
        &handle,
        &worker_name,
        database_id,
        &app,
        &plan,
        &constants,
        bridge,
    )?;
    stage_closure_fixtures(
        capture,
        artifact_bytes,
        &artifact_json,
        &owners,
        &seed,
        &handle,
        &worker_name,
        database_id,
        retained,
        bridge,
    )?;
    probe_r2(&bridge, &handle, &worker_name, &plan)?;
    probe_worker(
        &bridge,
        &backend,
        origin,
        &handle,
        &worker_name,
        &bundle,
        &seed,
        artifact,
    )?;
    let resource_recovery = plan
        .bindings
        .iter()
        .any(|b| b["kind"] == "queue" || b["kind"] == "analytics-engine");
    let example_binaries: BTreeMap<_, _> = bundle["binaries"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| {
            bundle::bytes(value).map(|bytes| (name.clone(), STANDARD.encode(bytes)))
        })
        .collect::<Result<_>>()?;
    Ok(Prepared {
        backend,
        recovery: if resource_recovery {
            Some(json!({"handle":handle,"workerName":worker_name}))
        } else {
            None
        },
        actors: seed["actors"].clone(),
        recipe: json!({"artifactBytes":STANDARD.encode(artifact_bytes),"artifactLabel":capture.compiler_operand,"sourceRevision":capture.source_revision,"worker":{"mainModule":bundle["mainModule"],"modules":bundle["modules"],"binaryModules":example_binaries},"workerName":format!("can-preview-examples-{}",random_id()?),"compatibilityDate":COMPATIBILITY_DATE,"d1Binding":"DB","runtime":{"handle":handle,"workerName":worker_name,"resourceRecovery":resource_recovery,"owners":owners,"databaseId":database_id,"seed":seed},"temporaryPersistence":temporary}),
    })
}
fn validate_preview_origin(origin: &str) -> Result<()> {
    let selected = url::Url::parse(origin).map_err(|e| e.to_string())?;
    if selected.scheme() != "http"
        || selected.host_str() != Some("127.0.0.1")
        || selected.port().is_none()
        || selected.path() != "/"
        || selected.query().is_some()
        || selected.fragment().is_some()
        || !selected.username().is_empty()
        || selected.password().is_some()
    {
        return Err("ORIGIN_INVALID: preview auth origin must be selected loopback origin".into());
    }
    Ok(())
}
fn provision_identity(
    capture: &Capture,
    artifact_json: &str,
    roles: &BTreeMap<String, Vec<String>>,
    retained: &mut Option<state::Retained>,
    persistence: &str,
    database_id: &str,
    bridge: &Bridge<'_>,
) -> Result<Value> {
    let provision_handle = format!("provision-{}", random_id()?);
    let provision_name = provision_handle.clone();
    let mut provision = json!({"bindings":{},"d1Databases":{"DB":database_id},"modules":runtime::modules("provision.js",&json!({"provision.js":"export default { fetch() { return new Response(null, {status:404}); } };"}),&json!({}))?});
    provision["r2Buckets"] = json!({});
    let empty = bindings::Plan {
        app: None,
        bindings: vec![],
        queue_handlers: vec![],
        no_model_storage_mode: None,
    };
    let (options, _) = runtime::options(
        &provision_handle,
        &provision_name,
        provision,
        &empty,
        Some(&persistence),
        false,
    )?;
    bridge.allocate(options)?;
    let seed = provision_seed(
        capture,
        artifact_json,
        roles,
        retained,
        &provision_handle,
        &provision_name,
        bridge,
    )?;
    bridge.call("mf.dispose", json!({"handle":provision_handle}))?;
    validate_seed(&seed)?;
    Ok(seed)
}
fn provision_seed(
    capture: &Capture,
    artifact_json: &str,
    roles: &BTreeMap<String, Vec<String>>,
    retained: &mut Option<state::Retained>,
    provision_handle: &str,
    provision_name: &str,
    bridge: &Bridge<'_>,
) -> Result<Value> {
    let seed = if let Some(seed) = retained.as_ref().and_then(|r| r.seed.clone()) {
        seed
    } else {
        if retained.is_some() {
            let existing = d1(
                &bridge,
                &provision_handle,
                &provision_name,
                "DB",
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity_users'",
            )?;
            if !existing.is_null() {
                return Err("PREVIEW_SEED_INCOMPLETE: retained Identity provisioning incomplete; state preserved".into());
            }
        }
        let resolved = resolve_preview_roles(roles, capture, artifact_json, bridge)?;
        let seed = seed(&bridge, &provision_handle, &provision_name, &resolved)?;
        if let Some(retained) = retained {
            retained.save_seed(seed.clone())?;
        }
        seed
    };
    Ok(seed)
}
fn resolve_preview_roles(
    roles: &BTreeMap<String, Vec<String>>,
    capture: &Capture,
    artifact_json: &str,
    bridge: &Bridge<'_>,
) -> Result<BTreeMap<String, Vec<String>>> {
    let resolved = if roles.is_empty() {
        roles.clone()
    } else {
        let work_dir = std::env::temp_dir().join(format!("can-preview-roles-{}", random_id()?));
        (bridge.call)(
            "resource.paths",
            Some(bridge.generation),
            json!({"temporary":work_dir}),
            &AtomicBool::new(false),
        )?;
        state::create_private_directory(&work_dir)?;
        let definition = bridge.call(
            "semantic.appDefinition",
            json!({"artifactJson":artifact_json,"sourcePath":capture.app_path,"workDir":work_dir}),
        )?;
        resolve_roles(roles.clone(), &definition)?
    };
    Ok(resolved)
}

fn activate_serving(
    capture: &Capture,
    artifact: &Value,
    artifact_json: &str,
    owners: &[Value],
    handle: &str,
    worker_name: &str,
    database_id: &str,
    app: &str,
    plan: &bindings::Plan,
    constants: &Value,
    bridge: &Bridge<'_>,
) -> Result<()> {
    if owners.is_empty() {
        activate(
            &bridge,
            &handle,
            &worker_name,
            "DB",
            None,
            None,
            &database_id,
            &app,
            artifact,
            &artifact_json,
            capture,
            &plan,
            &constants,
        )?;
    }
    for owner in owners {
        let team = bridge.call(
            "identity.findTeamById",
            binding_input(
                &handle,
                &worker_name,
                "DB",
                json!({"teamId":owner["owner"]}),
            ),
        )?;
        if team.is_null() {
            return Err(
                "IDENTITY_UNAVAILABLE: owner absent from separate Identity database".into(),
            );
        }
        activate(
            &bridge,
            &handle,
            &worker_name,
            owner["binding"].as_str().unwrap(),
            Some(owner["owner"].as_str().unwrap()),
            Some("DB"),
            owner["id"].as_str().unwrap(),
            &app,
            artifact,
            &artifact_json,
            capture,
            &plan,
            &constants,
        )?;
    }
    Ok(())
}

fn admit(capture: &Capture, artifact: &Value, delivery: bool) -> Result<()> {
    if capture.profile != "local-d1-identity" {
        return Err("PROFILE_UNSUPPORTED: unsupported preview profile".into());
    }
    capture::verify_compiler_sources(capture, artifact, true)
        .map_err(|e| format!("SOURCE_MISMATCH: {e}"))?;
    for name in ["compiler", "catalog", "help-index"] {
        if !capture
            .inputs
            .iter()
            .any(|i| i.name == name && i.state == "present")
        {
            return Err(format!("INPUT_UNAVAILABLE: captured {name} required"));
        }
    }
    if !capture
        .inputs
        .iter()
        .any(|i| i.name.starts_with("package:") && i.state == "present")
    {
        return Err("INPUT_UNAVAILABLE: package outputs required".into());
    }
    if delivery
        && artifact["pages"].as_array().map_or(0, Vec::len) == 0
        && artifact["operations"].as_array().map_or(0, Vec::len) == 0
    {
        return Err("PROFILE_UNSUPPORTED: app requires a page or operation".into());
    }
    for requirement in artifact["requires"]
        .as_array()
        .ok_or("capability inventory missing")?
    {
        let capability = requirement["capability"]
            .as_str()
            .ok_or("invalid capability")?;
        if !CAPABILITIES.contains(&capability)
            || requirement["min_version"].as_u64()
                != Some(if capability == "canlang.builtins" {
                    0
                } else {
                    1
                })
        {
            return Err(format!("CAPABILITY_UNAVAILABLE: {capability}"));
        }
    }
    Ok(())
}
fn app_name(source: &str) -> Result<String> {
    let names: Vec<_> = source
        .lines()
        .filter_map(|l| {
            l.trim_start()
                .strip_prefix("app")
                .filter(|v| v.starts_with(char::is_whitespace))
                .map(str::trim_start)
                .and_then(|v| {
                    v.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                        .next()
                })
                .filter(|s| !s.is_empty())
        })
        .collect();
    if names.len() != 1 {
        return Err("PROFILE_UNSUPPORTED: preview needs one app identity".into());
    }
    Ok(names[0].into())
}
fn storage_mode(artifact: &Value) -> Result<String> {
    let models = artifact
        .get("models")
        .map(|v| {
            v.as_array()
                .ok_or("MODEL_OWNERSHIP_INVALID: models must be an array")
        })
        .transpose()?
        .cloned()
        .unwrap_or_default();
    let mut by_name = BTreeMap::new();
    for model in &models {
        let name = model["name"]
            .as_str()
            .filter(|n| !n.is_empty())
            .ok_or("MODEL_OWNERSHIP_INVALID: model name invalid")?;
        if by_name.insert(name, model).is_some()
            || model.get("scope").is_some_and(|s| s != "app")
            || model
                .get("parent")
                .is_some_and(|p| !p.as_str().is_some_and(|s| !s.is_empty()))
            || model.get("parent").is_some() && model.get("scope").is_some()
        {
            return Err("MODEL_OWNERSHIP_INVALID: ownership invalid or duplicated".into());
        }
    }
    let mut modes = BTreeSet::new();
    for model in &models {
        let mut current = model;
        let mut seen = BTreeSet::new();
        loop {
            if !seen.insert(current["name"].as_str().unwrap()) {
                return Err("MODEL_OWNERSHIP_INVALID: ownership cycle".into());
            }
            if let Some(parent) = current.get("parent") {
                current = by_name
                    .get(parent.as_str().unwrap())
                    .ok_or("MODEL_OWNERSHIP_INVALID: missing parent")?;
            } else {
                modes.insert(if current["scope"] == "app" {
                    "global"
                } else {
                    "team"
                });
                break;
            }
        }
    }
    if modes.len() > 1 {
        return Err(
            "MIXED_OWNER_PROFILE_UNSUPPORTED: mixed State ownership requires owning selection API"
                .into(),
        );
    }
    Ok(if modes.contains("team") {
        "team"
    } else {
        "global"
    }
    .into())
}
/// Stage the closure's fixture rows into the serving owner databases after
/// activation created the schema and pinned the owner databases, so probes
/// and serving workers observe populated records. The worker reuses the
/// existing testkit fixture machinery under the seeded preview identity
/// (Ava/Ben self/other, Cal outsider; Cedar current, Oak other); the
/// retained marker skips staging while the artifact key still matches.
/// Previews without owner databases stage nothing.
#[allow(clippy::too_many_arguments)]
fn stage_closure_fixtures(
    capture: &Capture,
    artifact_bytes: &[u8],
    artifact_json: &str,
    owners: &[Value],
    seed: &Value,
    handle: &str,
    worker_name: &str,
    database_id: &str,
    retained: &mut Option<state::Retained>,
    bridge: &Bridge<'_>,
) -> Result<()> {
    if owners.len() != 2 {
        return Ok(());
    }
    let key = json!({"sourceRevision":capture.source_revision,
        "artifactDigest":format!("sha256:{}",capture::hash(artifact_json.as_bytes()))});
    if retained
        .as_ref()
        .and_then(|r| r.staged.clone())
        .is_some_and(|staged| staged == key)
    {
        return Ok(());
    }
    let team = |index: usize| {
        owners[index]["owner"]
            .as_str()
            .ok_or("preview owner team missing")
    };
    let binding = |index: usize| {
        owners[index]["binding"]
            .as_str()
            .ok_or("preview owner binding missing")
    };
    let user_id = |label: &str| {
        let email = seed["actors"]
            .as_array()
            .ok_or("preview seed actors missing")?
            .iter()
            .find(|actor| actor["label"] == label)
            .and_then(|actor| actor["email"].as_str())
            .ok_or(format!("preview seed actor {label} missing"))?;
        bridge
            .call(
                "identity.findUserByEmail",
                binding_input(handle, worker_name, "DB", json!({"email": email})),
            )?
            .get("user_id")
            .and_then(|id| id.as_str())
            .ok_or(format!("preview seed user {label} missing"))
            .map(str::to_string)
    };
    let ava = user_id("Ava")?;
    let ben = user_id("Ben")?;
    let cal = user_id("Cal")?;
    let staging_dir = std::env::temp_dir().join(format!("can-preview-stage-{}", random_id()?));
    state::create_private_directory(&staging_dir)?;
    let result = bridge.call(
        "testkit.stage",
        json!({"handle":handle,
            "input":{"applicationRoot":capture.root,
                "artifactBytes":STANDARD.encode(artifact_bytes),
                "artifactLabel":capture.compiler_operand,
                "sourceRevision":capture.source_revision,
                "workDir":staging_dir.to_string_lossy(),
                "bindings":{"self":{"id":ava.clone()},"other":{"id":ben.clone()},"outsider":{"id":cal.clone()}},
                "identity":{"currentTeamId":team(0)?,"otherTeamId":team(1)?,
                    "selfUserId":ava,"otherUserId":ben,"outsiderUserId":cal}},
            "databases":{"d1Id":database_id,"identityBinding":"DB",
                "currentOwnerBinding":binding(0)?,"otherOwnerBinding":binding(1)?}}),
    );
    let _ = std::fs::remove_dir_all(&staging_dir);
    if !result?["materialized"].is_array() {
        return Err("preview fixture staging returned no materialized receipt".into());
    }
    if let Some(retained) = retained {
        retained.save_staged(key)?;
    }
    Ok(())
}
fn binding_input(handle: &str, worker: &str, binding: &str, input: Value) -> Value {
    json!({"handle":handle,"workerName":worker,"binding":binding,"input":input})
}
fn d1(bridge: &Bridge, handle: &str, worker: &str, binding: &str, sql: &str) -> Result<Value> {
    bridge.call("d1.query",json!({"handle":handle,"workerName":worker,"binding":binding,"sql":sql,"params":[],"mode":"first"}))
}
#[allow(clippy::too_many_arguments)]
fn activate(
    bridge: &Bridge,
    handle: &str,
    worker: &str,
    binding: &str,
    owner: Option<&str>,
    identity_binding: Option<&str>,
    database_id: &str,
    app: &str,
    artifact: &Value,
    artifact_json: &str,
    capture: &Capture,
    plan: &bindings::Plan,
    constants: &Value,
) -> Result<()> {
    verify_owner_identity(bridge, handle, worker, binding, owner, identity_binding)?;
    bridge.call(
        "state.ensureSchema",
        binding_input(handle, worker, binding, json!({})),
    )?;
    let row = d1(
        bridge,
        handle,
        worker,
        binding,
        "SELECT COUNT(*) AS count FROM outbox",
    )?;
    if row["count"].as_u64() != Some(0) {
        return Err(
            "ACTIVATION_REFUSED: D1 work inventory unavailable or contains outstanding work".into(),
        );
    }
    let requirement = json!({"binding":"DB","kind":"d1","logicalName":"local-preview-db"});
    let resources = plan.resources();
    let descriptor = json!({"identity":{"appName":app,"sourceRevision":capture.source_revision,"languageVersion":artifact["language_version"],"compilerVersion":artifact["tool_version"],"contractsVersion":constants["contractsVersion"],"artifactDigest":format!("sha256:{}",capture::hash(artifact_json.as_bytes()))},"requiredCapabilities":artifact["requires"].as_array().unwrap().iter().map(|v|v["capability"].clone()).collect::<Vec<_>>(),"resourceBindings":std::iter::once(requirement.clone()).chain(resources.iter().map(|v|v["requirement"].clone())).collect::<Vec<_>>(),"secrets":[],"schedules":[]});
    let environment = json!({"environment":"local-preview","resources":std::iter::once(json!({"requirement":requirement,"resourceId":database_id})).chain(resources).collect::<Vec<_>>(),"secretsPresent":[],"vars":{}});
    let verdict=bridge.call("semantic.activate",json!({"handle":handle,"workerName":worker,"binding":binding,"identityBinding":identity_binding,"owner":owner,"artifactJson":artifact_json,"descriptor":descriptor,"environment":environment,"installed":{"contractsVersion":constants["contractsVersion"],"runtimeVersion":constants["releaseVersion"],"knownLanguageVersions":["1.0"],"capabilities":CAPABILITIES,"supportsSchedules":false},"inventory":{"outboxItems":[],"plan":{"migrationId":format!("preview:{}",capture.source_revision),"invalidates":[]}}}))?;
    if verdict["active"] != true {
        return Err("ACTIVATION_REFUSED: installed activation gates refused preview".into());
    }
    if let Some(owner) = owner {
        bridge.call("state.ownerScoped",json!({"handle":handle,"workerName":worker,"binding":binding,"app":app,"owner":owner,"initializeFresh":true}))?;
    }
    Ok(())
}
fn verify_owner_identity(
    bridge: &Bridge,
    handle: &str,
    worker: &str,
    binding: &str,
    owner: Option<&str>,
    identity_binding: Option<&str>,
) -> Result<()> {
    if let Some(owner) = owner {
        let identity_binding = identity_binding
            .filter(|selected| *selected != binding)
            .ok_or(
                "IDENTITY_UNAVAILABLE: serving owner requires separate real Identity database",
            )?;
        let team = bridge.call(
            "identity.findTeamById",
            binding_input(handle, worker, identity_binding, json!({"teamId":owner})),
        )?;
        if team.is_null() {
            return Err("IDENTITY_UNAVAILABLE: serving owner must exist in its separate real Identity database".into());
        }
    }
    Ok(())
}
fn role_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|part| {
            let mut bytes = part.bytes();
            bytes
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
                && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
}
fn parse_roles(value: &Value) -> Result<BTreeMap<String, Vec<String>>> {
    let mut result = BTreeMap::new();
    for (actor, roles) in value
        .as_object()
        .ok_or("preview roles must map actor labels to role names")?
    {
        if !["Ava", "Ben", "Cal", "Dee"].contains(&actor.as_str()) {
            return Err("preview roles require known seeded actors".into());
        }
        let mut seen = BTreeSet::new();
        let roles = roles
            .as_array()
            .filter(|v| v.len() <= 32)
            .ok_or("preview roles require at most 32 assignments per actor")?
            .iter()
            .map(|r| {
                let role = r
                    .as_str()
                    .filter(|r| role_name(r) && seen.insert(*r))
                    .ok_or("preview roles require distinct declared role names")?;
                Ok(role.to_string())
            })
            .collect::<Result<Vec<_>>>()?;
        result.insert(actor.clone(), roles);
    }
    Ok(result)
}
fn resolve_roles(
    request: BTreeMap<String, Vec<String>>,
    definition: &Value,
) -> Result<BTreeMap<String, Vec<String>>> {
    let declared = definition["policy"]["roles"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut candidates = vec![];
    if let Some(packages) = definition["packages"].as_object() {
        for package in packages.values() {
            if let Some(roles) = package["roles"].as_object() {
                for (short, role) in roles {
                    if role["id"].is_string() && declared.contains(&role["id"]) {
                        candidates.push((short.clone(), role["id"].as_str().unwrap().to_string()));
                    }
                }
            }
        }
    }
    request
        .into_iter()
        .map(|(actor, roles)| {
            let mut seen = BTreeSet::new();
            let resolved = roles
                .into_iter()
                .map(|name| {
                    let matches: BTreeSet<_> = candidates
                        .iter()
                        .filter(|(short, id)| *short == name || *id == name)
                        .map(|(_, id)| id.clone())
                        .collect();
                    if matches.len() != 1 {
                        return Err(format!(
                            "preview role {name:?} absent or ambiguous in compiled app"
                        ));
                    }
                    let id = matches.into_iter().next().unwrap();
                    if !seen.insert(id.clone()) {
                        return Err("preview roles contain duplicate canonical assignments".into());
                    }
                    Ok(id)
                })
                .collect::<Result<Vec<_>>>()?;
            Ok((actor, resolved))
        })
        .collect()
}
fn seed(
    bridge: &Bridge,
    handle: &str,
    worker: &str,
    roles: &BTreeMap<String, Vec<String>>,
) -> Result<Value> {
    bridge.call(
        "identity.ensureSchema",
        binding_input(handle, worker, "DB", json!({})),
    )?;
    let cedar = bridge.call(
        "identity.createTeam",
        binding_input(handle, worker, "DB", json!({})),
    )?;
    let oak = bridge.call(
        "identity.createTeam",
        binding_input(handle, worker, "DB", json!({})),
    )?;
    let cedar = cedar["team_id"]
        .as_str()
        .ok_or("Identity team ID missing")?;
    let oak = oak["team_id"].as_str().ok_or("Identity team ID missing")?;
    let profiles = [
        (
            "Ava",
            "ava@preview.can.test",
            vec!["Cedar"],
            Some(cedar),
            true,
        ),
        (
            "Ben",
            "ben@preview.can.test",
            vec!["Cedar"],
            Some(cedar),
            false,
        ),
        ("Cal", "cal@preview.can.test", vec!["Oak"], Some(oak), true),
        ("Dee", "dee@preview.can.test", vec![], None, false),
    ];
    let mut actors = vec![];
    let mut users = BTreeMap::new();
    for (label, email, teams, team, owner) in &profiles {
        let password = random_secret(24)?;
        let hashed = bridge.call("identity.hashPassword", json!({"password":password}))?;
        let hash = hashed
            .as_str()
            .or_else(|| hashed["hash"].as_str())
            .ok_or("password hash missing")?;
        let user = bridge.call(
            "identity.createUser",
            binding_input(
                handle,
                worker,
                "DB",
                json!({"email":email,"password_hash":hash,"email_verified":true}),
            ),
        )?;
        let id = user["user_id"]
            .as_str()
            .ok_or("Identity user ID missing")?
            .to_string();
        if let Some(team) = team {
            bridge.call(
                "identity.createMembership",
                binding_input(
                    handle,
                    worker,
                    "DB",
                    json!({"team_id":team,"user_id":id,"is_owner":owner,"roles":[]}),
                ),
            )?;
        }
        users.insert(*label, id);
        actors.push(json!({"label":label,"email":email,"password":password,"teams":teams}));
    }
    for (label, roles) in roles {
        if roles.is_empty() {
            continue;
        }
        let profile = profiles.iter().find(|p| p.0 == label).unwrap();
        let team = profile
            .3
            .ok_or("preview role actor must belong to seeded team")?;
        let owner = profiles.iter().find(|p| p.3 == Some(team) && p.4).unwrap();
        for role in roles {
            bridge.call("identity.setMemberRole",binding_input(handle,worker,"DB",json!({"request":{"team_id":team,"member_user_id":users[label.as_str()],"role":role},"authority":{"granted_by":users[owner.0]}})))?;
        }
    }
    Ok(
        json!({"actors":actors,"probe":{"email":actors[0]["email"],"password":actors[0]["password"],"teamId":cedar},"owners":[{"owner":cedar,"binding":"STATE_CEDAR_DB"},{"owner":oak,"binding":"STATE_OAK_DB"}]}),
    )
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn validate_seed(seed: &Value) -> Result<()> {
    let actors = seed["actors"].as_array().ok_or("Identity actors missing")?;
    let owners = seed["owners"].as_array().ok_or("Identity owners missing")?;
    let mut owner_ids = BTreeSet::new();
    let mut bindings = BTreeSet::new();
    if actors.len() != 4
        || !actors.iter().any(|a| {
            a["email"] == seed["probe"]["email"] && a["password"] == seed["probe"]["password"]
        })
        || owners.len() != 2
        || !owners.iter().any(|o| o["owner"] == seed["probe"]["teamId"])
        || owners.iter().any(|o| {
            !o["owner"]
                .as_str()
                .is_some_and(|v| uuid(v) && owner_ids.insert(v))
                || !o["binding"].as_str().is_some_and(|v| {
                    ["STATE_CEDAR_DB", "STATE_OAK_DB"].contains(&v) && bindings.insert(v)
                })
        })
    {
        return Err("IDENTITY_UNAVAILABLE: expected isolated seeded team matrix missing".into());
    }
    Ok(())
}
fn probe_r2(bridge: &Bridge, handle: &str, worker: &str, plan: &bindings::Plan) -> Result<()> {
    for binding in plan.bindings.iter().filter(|b| b["kind"] == "r2") {
        let key = format!(".can-preview-probe/{}", random_id()?);
        let value = random_id()?;
        let payload = |value: Value| json!({"handle":handle,"workerName":worker,"binding":binding["binding"],"key":key,"value":value});
        let probe: Result<()> = (|| {
            bridge.call("r2.put", payload(json!(value)))?;
            let observed = bridge.call("r2.get", payload(Value::Null))?;
            if observed.as_str() != Some(&value) {
                return Err("R2 failed to retain exact probe bytes".into());
            }
            Ok(())
        })();
        // Delete independently after failed put/get. The parent retains the SDK
        // handle if cancellation prevents an ordinary primitive cleanup call.
        let deleted = bridge.call("r2.delete", payload(Value::Null));
        probe?;
        deleted?;
        if !bridge.call("r2.get", payload(Value::Null))?.is_null() {
            return Err("R2_UNAVAILABLE: private R2 probe was not deleted".into());
        }
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn probe_worker(
    bridge: &Bridge,
    backend: &Backend,
    origin: &str,
    handle: &str,
    worker: &str,
    bundle: &Value,
    seed: &Value,
    artifact: &Value,
) -> Result<()> {
    if d1(bridge, handle, worker, "DB", "SELECT 1 AS ready")?["ready"] != 1 {
        return Err("D1_UNAVAILABLE: local DB did not answer query".into());
    }
    let cookie = probe_identity(bridge, backend, origin, seed)?;
    let grant_token = probe_team_grant(bridge, backend, origin, seed, &cookie)?;
    let has_operations = probe_tools(bridge, backend, origin, artifact, &grant_token)?;
    probe_assets(bridge, backend, origin, bundle)?;
    probe_page(bridge, backend, origin, artifact, &cookie, has_operations)
}
fn probe_get(
    bridge: &Bridge<'_>,
    backend: &Backend,
    origin: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Result<http::Response> {
    http::request(backend, origin, path, "GET", headers, vec![], bridge.cancel)
}
fn probe_post(
    bridge: &Bridge<'_>,
    backend: &Backend,
    origin: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Value,
) -> Result<http::Response> {
    let mut h = vec![("content-type", "application/json")];
    h.extend_from_slice(headers);
    http::request(
        backend,
        origin,
        path,
        "POST",
        &h,
        serde_json::to_vec(&body).map_err(|e| e.to_string())?,
        bridge.cancel,
    )
}
fn probe_identity(
    bridge: &Bridge<'_>,
    backend: &Backend,
    origin: &str,
    seed: &Value,
) -> Result<String> {
    let auth = probe_get(bridge, backend, origin, "/auth/login", &[])?;
    if auth.status != 200 || !auth.content_type("application/json") {
        return Err("IDENTITY_UNAVAILABLE: login descriptor route failed".into());
    }
    let descriptor = auth.json()?;
    let token = descriptor["preSessionToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Identity pre-session token missing")?;
    if descriptor["form"] != "login" || descriptor["postTo"] != "/auth/login" {
        return Err("IDENTITY_UNAVAILABLE: login descriptor invalid".into());
    }
    let presession = auth.cookie("can_presession")?;
    let login = probe_post(
        bridge,
        backend,
        origin,
        "/auth/login",
        &[("cookie", &presession)],
        json!({"email":seed["probe"]["email"],"password":seed["probe"]["password"],"_presession":token}),
    )?;
    if login.status != 200 {
        return Err("IDENTITY_UNAVAILABLE: seeded member login refused".into());
    }
    let cookie = login.cookie("can_session")?;
    Ok(cookie)
}
fn probe_team_grant(
    bridge: &Bridge<'_>,
    backend: &Backend,
    origin: &str,
    seed: &Value,
    cookie: &str,
) -> Result<String> {
    let csrf = bridge.call("identity.csrf", json!({"cookie":cookie}))?;
    let csrf = csrf["csrf"]
        .as_str()
        .or_else(|| csrf.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Identity current CSRF missing")?;
    let headers = [("cookie", cookie), ("x-csrf-token", csrf)];
    let selection = probe_post(
        bridge,
        backend,
        origin,
        "/auth/select-team",
        &headers,
        json!({"team":seed["probe"]["teamId"],"_csrf":csrf}),
    )?;
    if selection.status != 200 {
        return Err("IDENTITY_UNAVAILABLE: seeded member team selection refused".into());
    }
    let grant = probe_post(
        bridge,
        backend,
        origin,
        "/mcp/grants",
        &headers,
        json!({"client_id":"can-dev-local-probe"}),
    )?;
    let granted = grant.json()?;
    let grant_token = granted["token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("MCP_UNAVAILABLE: member grant missing")?;
    if grant.status != 200 {
        return Err("MCP_UNAVAILABLE: grant refused".into());
    }
    Ok(grant_token.to_owned())
}
fn probe_tools(
    bridge: &Bridge<'_>,
    backend: &Backend,
    origin: &str,
    artifact: &Value,
    grant_token: &str,
) -> Result<bool> {
    let authorization = format!("Bearer {grant_token}");
    let discovery = probe_post(
        bridge,
        backend,
        origin,
        "/mcp",
        &[
            ("accept", "application/json, text/event-stream"),
            ("authorization", authorization.as_str()),
        ],
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )?;
    let discovered = discovery.json()?;
    let tools = discovered["result"]["tools"]
        .as_array()
        .ok_or("MCP_UNAVAILABLE: tools response invalid")?;
    let has_operations = artifact["operations"]
        .as_array()
        .is_some_and(|v| !v.is_empty());
    if discovery.status != 200
        || (has_operations && tools.is_empty())
        || (!has_operations && !tools.is_empty())
    {
        return Err("MCP_UNAVAILABLE: business tools inconsistent with checked inventory".into());
    }
    let anonymous = probe_post(
        bridge,
        backend,
        origin,
        "/mcp",
        &[("accept", "application/json, text/event-stream")],
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
    )?;
    if anonymous.status != 401 || !anonymous.content_type("application/json") {
        return Err("MCP_UNAVAILABLE: anonymous business MCP caller was not refused".into());
    }
    Ok(has_operations)
}
fn probe_assets(
    bridge: &Bridge<'_>,
    backend: &Backend,
    origin: &str,
    bundle: &Value,
) -> Result<()> {
    for (key, resource) in bundle["resources"].as_object().unwrap() {
        let path = format!(
            "/assets/{}",
            key.split('/')
                .map(|s| url::form_urlencoded::byte_serialize(s.as_bytes())
                    .collect::<String>()
                    .replace('+', "%20"))
                .collect::<Vec<_>>()
                .join("/")
        );
        let response = probe_get(bridge, backend, origin, &path, &[])?;
        if response.status != 200
            || !response.content_type(resource["contentType"].as_str().unwrap())
            || response.body != bundle::bytes(&resource["bytes"])?
        {
            return Err(format!(
                "RESOURCE_INVALID: installed Worker did not serve packaged {key} bytes"
            ));
        }
    }
    Ok(())
}
fn probe_page(
    bridge: &Bridge<'_>,
    backend: &Backend,
    origin: &str,
    artifact: &Value,
    cookie: &str,
    has_operations: bool,
) -> Result<()> {
    let pages = artifact["pages"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let page = pages
        .iter()
        .find(|p| p["path"] == "/")
        .or_else(|| pages.first());
    if let Some(page) = page {
        let path = page["path"]
            .as_str()
            .filter(|s| s.starts_with('/'))
            .ok_or("PAGE_UNAVAILABLE: invalid app-relative route")?;
        let response = probe_get(bridge, backend, origin, path, &[("cookie", &cookie)])?;
        if response.status != 200 || !response.content_type("text/html") {
            return Err("PAGE_UNAVAILABLE: installed page route failed".into());
        }
    } else if !has_operations {
        return Err("PAGE_UNAVAILABLE: no page or operation declared".into());
    }
    Ok(())
}

/// Isolated examples use the same native module mapping and private transport.
pub fn isolated_options(
    handle: &str,
    worker_name: &str,
    worker: &Value,
    d1_databases: Value,
    vars: Value,
) -> Result<(Value, String)> {
    let mut options = json!({"bindings":vars,"d1Databases":d1_databases,"modules":runtime::modules(worker["mainModule"].as_str().ok_or("main module missing")?,&worker["modules"],&worker["binaryModules"])?});
    options["r2Buckets"] = json!({});
    let empty = bindings::Plan {
        app: None,
        bindings: vec![],
        queue_handlers: vec![],
        no_model_storage_mode: None,
    };
    runtime::options(handle, worker_name, options, &empty, None, false)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_is_resolved_and_mixed_roots_refused() {
        assert_eq!(storage_mode(&json!({"models":[{"name":"Parent","scope":"app"},{"name":"Child","parent":"Parent"}]})).unwrap(),"global");
        assert!(
            storage_mode(&json!({"models":[{"name":"A"},{"name":"B","scope":"app"}]}))
                .unwrap_err()
                .contains("MIXED_OWNER")
        );
        assert!(storage_mode(&json!({"models":[{"name":"A","parent":"A"}]})).is_err());
    }
    #[test]
    fn native_hook_handlers_admit_without_queue_selection() {
        let plan = bindings::Plan {
            app: Some("Shop".into()),
            bindings: vec![],
            queue_handlers: vec!["shop.queued".into()],
            no_model_storage_mode: None,
        };
        let artifact = json!({
            "callables": [
                {"id": "shop.Order.create", "kind": "operation"},
                {"id": "shop.queued", "kind": "handler"},
                {"id": "shop.snapshot_Order_create", "kind": "handler"},
                {"id": "shop.unchecked", "kind": "handler"},
            ],
            "modelPolicies": [
                {"model": "shop.Order", "hooks": [{"id": "shop.snapshot_Order_create", "op": "create", "operation": "shop.Order.create"}]},
            ],
        });
        assert!(
            validate_selected_callables(&artifact, &plan)
                .unwrap_err()
                .contains("PROFILE_UNSUPPORTED")
        );
        let artifact = json!({
            "callables": [
                {"id": "shop.Order.create", "kind": "operation"},
                {"id": "shop.queued", "kind": "handler"},
                {"id": "shop.snapshot_Order_create", "kind": "handler"},
            ],
            "modelPolicies": [
                {"model": "shop.Order", "hooks": [{"id": "shop.snapshot_Order_create", "op": "create", "operation": "shop.Order.create"}]},
            ],
        });
        assert!(validate_selected_callables(&artifact, &plan).is_ok());
        let artifact = json!({
            "callables": [{"id": "shop.migrate", "kind": "migration"}],
            "modelPolicies": [],
        });
        assert!(
            validate_selected_callables(&artifact, &plan)
                .unwrap_err()
                .contains("PROFILE_UNSUPPORTED")
        );
    }
    #[test]
    fn serving_owner_requires_separate_existing_identity_before_state_mutation() {
        use std::cell::RefCell;
        let seen = RefCell::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let call = |command: &str, _: Option<&str>, payload: Value, _: &AtomicBool| {
            seen.borrow_mut().push((command.to_owned(), payload));
            Ok(Value::Null)
        };
        let bridge = Bridge {
            generation: "test",
            call: &call,
            cancel: &cancel,
        };
        for identity in [None, Some("STATE")] {
            assert!(
                verify_owner_identity(&bridge, "mf", "worker", "STATE", Some("owner"), identity)
                    .unwrap_err()
                    .contains("IDENTITY_UNAVAILABLE")
            );
        }
        assert!(seen.borrow().is_empty());
        assert!(
            verify_owner_identity(
                &bridge,
                "mf",
                "worker",
                "STATE",
                Some("owner"),
                Some("IDENTITY")
            )
            .is_err()
        );
        assert_eq!(seen.borrow().len(), 1);
        assert_eq!(seen.borrow()[0].0, "identity.findTeamById");
        assert_eq!(seen.borrow()[0].1["binding"], "IDENTITY");
        assert_eq!(seen.borrow()[0].1["input"]["teamId"], "owner");
        let call = |command: &str, _: Option<&str>, _: Value, _: &AtomicBool| {
            assert_eq!(command, "identity.findTeamById");
            Ok(json!({"team_id":"owner"}))
        };
        let bridge = Bridge {
            generation: "test",
            call: &call,
            cancel: &cancel,
        };
        verify_owner_identity(
            &bridge,
            "mf",
            "worker",
            "STATE",
            Some("owner"),
            Some("IDENTITY"),
        )
        .unwrap();
    }
    #[test]
    fn staging_calls_testkit_stage_with_seeded_identity_and_skips_without_owners() {
        use std::cell::RefCell;
        let (_project, request) = crate::capture::tests::fixture();
        let capture = crate::capture::capture(
            &request,
            &crate::capture::tests::empty_inventory,
            &AtomicBool::new(false),
        )
        .unwrap();
        let seed = json!({"actors":[
            {"label":"Ava","email":"ava@preview.can.test"},
            {"label":"Ben","email":"ben@preview.can.test"},
            {"label":"Cal","email":"cal@preview.can.test"},
            {"label":"Dee","email":"dee@preview.can.test"}],
            "owners":[{"owner":"cedar","binding":"STATE_CEDAR_DB"},{"owner":"oak","binding":"STATE_OAK_DB"}]});
        let owners = seed["owners"].as_array().unwrap().clone();
        let seen = RefCell::new(Vec::new());
        let call = |command: &str, _: Option<&str>, payload: Value, _: &AtomicBool| {
            seen.borrow_mut()
                .push((command.to_owned(), payload.clone()));
            match command {
                "identity.findUserByEmail" => Ok(
                    json!({"user_id":format!("user-{}",payload["input"]["email"].as_str().unwrap())}),
                ),
                "testkit.stage" => Ok(json!({"materialized":["a","b"]})),
                _ => panic!("unexpected {command}"),
            }
        };
        let bridge = Bridge {
            generation: "test",
            call: &call,
            cancel: &AtomicBool::new(false),
        };
        let mut retained: Option<state::Retained> = None;
        stage_closure_fixtures(
            &capture,
            b"artifact",
            "{\"models\":[]}",
            &owners,
            &seed,
            "mf",
            "worker",
            "db",
            &mut retained,
            &bridge,
        )
        .unwrap();
        {
            let events = seen.borrow();
            assert_eq!(events.len(), 4);
            for (event, email) in events.iter().take(3).zip([
                "ava@preview.can.test",
                "ben@preview.can.test",
                "cal@preview.can.test",
            ]) {
                assert_eq!(event.0, "identity.findUserByEmail");
                assert_eq!(event.1["binding"], "DB");
                assert_eq!(event.1["input"]["email"], email);
            }
            let stage = &events[3].1;
            assert_eq!(events[3].0, "testkit.stage");
            assert_eq!(stage["handle"], "mf");
            assert_eq!(
                stage["input"]["artifactLabel"].as_str(),
                Some(capture.compiler_operand.as_str())
            );
            assert_eq!(
                stage["input"]["sourceRevision"].as_str(),
                Some(capture.source_revision.as_str())
            );
            assert!(stage["input"]["artifactBytes"].is_string());
            assert!(
                stage["input"]["workDir"]
                    .as_str()
                    .unwrap()
                    .contains("can-preview-stage-")
            );
            assert_eq!(
                stage["input"]["bindings"],
                json!({"self":{"id":"user-ava@preview.can.test"},"other":{"id":"user-ben@preview.can.test"},"outsider":{"id":"user-cal@preview.can.test"}})
            );
            assert_eq!(
                stage["input"]["identity"],
                json!({"currentTeamId":"cedar","otherTeamId":"oak","selfUserId":"user-ava@preview.can.test","otherUserId":"user-ben@preview.can.test","outsiderUserId":"user-cal@preview.can.test"})
            );
            assert_eq!(
                stage["databases"],
                json!({"d1Id":"db","identityBinding":"DB","currentOwnerBinding":"STATE_CEDAR_DB","otherOwnerBinding":"STATE_OAK_DB"})
            );
        }
        // Previews without owner databases stage nothing and call nothing.
        seen.borrow_mut().clear();
        stage_closure_fixtures(
            &capture,
            b"artifact",
            "{\"models\":[]}",
            &[],
            &seed,
            "mf",
            "worker",
            "db",
            &mut retained,
            &bridge,
        )
        .unwrap();
        assert!(seen.borrow().is_empty());
    }
    #[test]
    fn role_aliases_must_be_unique() {
        let roles = parse_roles(&json!({"Ava":["Reader"]})).unwrap();
        let definition = json!({"policy":{"roles":["Office.Reader"]},"packages":{"Office":{"roles":{"Reader":{"id":"Office.Reader"}}}}});
        assert_eq!(
            resolve_roles(roles, &definition).unwrap()["Ava"],
            vec!["Office.Reader"]
        );
        assert!(parse_roles(&json!({"Unknown":["Reader"]})).is_err());
    }
}

/// Private semantic-test policy surface. All callbacks are fixed SDK methods;
/// callers may lend actual SDK objects, but cannot replace admission decisions.
pub fn test_policy(
    operation: &str,
    input: &Value,
    generation: &str,
    call: &Call<'_>,
    cancel: &AtomicBool,
) -> Result<Value> {
    let bridge = Bridge {
        generation,
        call,
        cancel,
    };
    match operation {
        "vars" => return test_vars(input),
        "roles" => {
            return serde_json::to_value(resolve_roles(
                parse_roles(&input["roles"])?,
                &input["definition"],
            )?)
            .map_err(|e| e.to_string());
        }
        "worker" => return test_worker(input, &bridge),
        "seed" => {
            return seed(
                &bridge,
                "policy-input",
                "provided",
                &parse_roles(input.get("roles").unwrap_or(&json!({})))?,
            );
        }
        "gateway" => return test_gateway(&bridge),
        _ => {}
    }
    let captured: Capture =
        serde_json::from_value(input["capture"].clone()).map_err(|e| e.to_string())?;
    let artifact = &input["artifact"];
    let artifact_json = input["artifactJson"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| artifact.to_string());
    if serde_json::from_str::<Value>(&artifact_json).map_err(|e| e.to_string())? != *artifact {
        return Err("test artifact bytes differ from checked artifact".into());
    }
    match operation {
        "activation" => test_activation(input, &captured, artifact, &artifact_json, &bridge),
        "evidence" => test_evidence(&captured, artifact, &artifact_json, &bridge),
        "preview" | "browser" => {
            test_preview(operation, &captured, artifact, &artifact_json, &bridge)
        }
        _ => Err("unknown native test policy operation".into()),
    }
}
fn test_vars(input: &Value) -> Result<Value> {
    let origin = input["origin"]
        .as_str()
        .ok_or("preview test origin missing")?;
    let url = url::Url::parse(origin).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("ORIGIN_INVALID: selected loopback origin required".into());
    }
    return Ok(
        json!({"CAN_AUTH_ORIGIN":origin,"CAN_DEPLOYMENT_BASE":origin,"CAN_LOCAL_FILES":true}),
    );
}
fn test_worker(input: &Value, bridge: &Bridge<'_>) -> Result<Value> {
    let options = &input["options"];
    let payload = test_worker_options(options)?;
    let handle = payload["handle"]
        .as_str()
        .ok_or("test worker handle missing")?
        .to_owned();
    test_register_paths(&payload, bridge)?;
    let created = bridge.allocate(payload.clone())?;
    bridge.call(
        "test.worker.ready",
        json!({"handle":handle,"backend":created["backend"],"analytics":payload["analytics"]}),
    )?;
    if options["resourceRecovery"] == true {
        test_recovery_loop(options, &handle, bridge)?;
    } else {
        bridge.call("test.worker.close", json!({}))?;
    }
    return Ok(json!({"closed":true}));
}
fn test_register_paths(payload: &Value, bridge: &Bridge<'_>) -> Result<()> {
    for path in payload["temporaryPaths"].as_array().into_iter().flatten() {
        if let Err(error) = bridge.call("test.resourcePath", json!({"path":path})) {
            // No SDK allocation has begun, so native-owned scratch can be removed here.
            for owned in payload["temporaryPaths"].as_array().into_iter().flatten() {
                if let Some(path) = owned.as_str() {
                    std::fs::remove_dir_all(path)
                        .map_err(|cleanup| format!("{error}; scratch cleanup failed: {cleanup}"))?;
                }
            }
            return Err(error);
        }
    }
    Ok(())
}
fn test_recovery_loop(options: &Value, handle: &str, bridge: &Bridge<'_>) -> Result<()> {
    let mut reported = false;
    loop {
        let next = bridge.call("test.worker.next", json!({"waitMs":1000}))?;
        if next["close"] == true {
            break;
        }
        let result = bridge.call("mf.scheduled", json!({"handle":handle,"workerName":options["workerName"],"cron":"can-resource-recovery"}));
        let failed = result
            .as_ref()
            .map_or(true, |value| value["outcome"] != "ok");
        if failed && !reported {
            eprintln!(
                "Local resource recovery failed; retrying while the SDK host remains available."
            );
        }
        reported = failed;
    }
    Ok(())
}
fn test_gateway(bridge: &Bridge<'_>) -> Result<Value> {
    let mut gateway = crate::gateway::Gateway::bind().map_err(|e| e.to_string())?;
    let backend = bridge.call("test.gateway.backend", json!({"url":gateway.origin()}))?;
    if !backend.is_null() {
        gateway
            .set_backend(serde_json::from_value(backend).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        test_gateway_control(&bridge, &gateway, "test.gateway.control", json!({}))?;
    }
    gateway.shutdown().map_err(|e| e.to_string())?;
    return Ok(json!({"closed":true}));
}
fn test_activation(
    input: &Value,
    captured: &Capture,
    artifact: &Value,
    artifact_json: &str,
    bridge: &Bridge<'_>,
) -> Result<Value> {
    admit(&captured, artifact, false)?;
    let plan = bindings::plan(artifact, None)?;
    let constants = bridge.call("runtime.constants", json!({}))?;
    let app = plan.app.clone().unwrap_or(app_name(&captured.source_text)?);
    activate(
        &bridge,
        "policy-input",
        "provided",
        "STATE",
        input["owner"].as_str(),
        input["identityBinding"].as_str(),
        input["databaseId"]
            .as_str()
            .ok_or("test database ID missing")?,
        &app,
        artifact,
        &artifact_json,
        &captured,
        &plan,
        &constants,
    )?;
    return Ok(json!({"active":true,"reasons":[]}));
}
fn test_evidence(
    captured: &Capture,
    artifact: &Value,
    artifact_json: &str,
    bridge: &Bridge<'_>,
) -> Result<Value> {
    let built = build(
        &captured,
        artifact,
        artifact_json.as_bytes(),
        &json!({}),
        &bridge,
        false,
    )?;
    return Ok(
        json!({"verdict":{"active":true,"reasons":[]},"bundle":built.bundle,"captureEpochMaterial":captured.epoch_material,
            "artifactJsonSha256":capture::hash(artifact_json.as_bytes()),"consumedInputs":captured.inputs}),
    );
}
fn test_preview(
    operation: &str,
    captured: &Capture,
    artifact: &Value,
    artifact_json: &str,
    bridge: &Bridge<'_>,
) -> Result<Value> {
    let directory = tempfile::Builder::new()
        .prefix("can-native-preview-test-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .map_err(|e| e.to_string())?;
    let path = directory.keep();
    if let Err(error) = bridge.call("test.resourcePath", json!({"path":path})) {
        // The host has not allocated Miniflare yet; preserve its SDK ordering on failure.
        std::fs::remove_dir_all(&path)
            .map_err(|cleanup| format!("{error}; scratch cleanup failed: {cleanup}"))?;
        return Err(error);
    }
    let mut gateway = crate::gateway::Gateway::bind().map_err(|e| e.to_string())?;
    let result = (|| {
        let prepared = prepare(
            &captured,
            artifact,
            artifact_json.as_bytes(),
            bridge.generation,
            gateway.origin(),
            Some(&path),
            &json!({}),
            bridge.call,
            bridge.cancel,
        )?;
        gateway
            .set_backend(prepared.backend.clone())
            .map_err(|e| e.to_string())?;
        if operation == "browser" {
            return crate::qualification::test_browser(
                &prepared,
                artifact,
                &captured,
                &gateway,
                bridge.generation,
                bridge.call,
                bridge.cancel,
            );
        }
        test_gateway_control(
            &bridge,
            &gateway,
            "test.preview.ready",
            json!({"url":gateway.origin(),"actors":prepared.actors}),
        )?;
        Ok(json!({"closed":true}))
    })();
    gateway.shutdown().map_err(|e| e.to_string())?;
    return result;
}

fn test_gateway_control(
    bridge: &Bridge,
    gateway: &crate::gateway::Gateway,
    initial: &str,
    mut payload: Value,
) -> Result<()> {
    let mut command = initial;
    loop {
        let request = bridge.call(command, payload)?;
        match request["operation"].as_str() {
            Some("close") => return Ok(()),
            Some("mint") => {
                payload = json!({"openUrl":gateway.mint_access().map_err(|e| e.to_string())?})
            }
            _ => return Err("unknown native preview test control".into()),
        }
        command = "test.preview.control";
    }
}
fn test_worker_fields(input: &Value) -> Result<Value> {
    let name = input["workerName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("test worker name missing")?;
    let date = input["compatibilityDate"]
        .as_str()
        .ok_or("test Worker date missing")?;
    let main = input["mainModule"]
        .as_str()
        .ok_or("test Worker entry missing")?;
    let mut modules = input["modules"].clone();
    if let Some(maps) = input["sourceMaps"].as_object() {
        for (name, map) in maps {
            if let Some(source) = modules[name].as_str() {
                modules[name] = json!(format!(
                    "{source}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,{}\n",
                    STANDARD.encode(map.to_string().as_bytes())
                ));
            }
        }
    }
    let mut worker = json!({"name":name,"compatibilityDate":date,"compatibilityFlags":input.get("compatibilityFlags").cloned().unwrap_or(json!([])),
        "modules":runtime::modules(main,&modules,input.get("binaryModules").unwrap_or(&json!({})))?,"bindings":input.get("vars").cloned().unwrap_or(json!({}))});
    for (key, id) in [
        ("d1Databases", "id"),
        ("r2Buckets", "id"),
        ("kvNamespaces", "id"),
    ] {
        let mut bindings = serde_json::Map::new();
        for entry in input[key].as_array().into_iter().flatten() {
            let binding = entry["binding"]
                .as_str()
                .ok_or("test resource binding missing")?;
            if bindings.insert(binding.into(), entry[id].clone()).is_some() {
                return Err("duplicate test resource binding".into());
            }
        }
        worker[key] = Value::Object(bindings);
    }
    let mut durable = serde_json::Map::new();
    for entry in input["durableObjects"].as_array().into_iter().flatten() {
        let mut value = entry
            .as_object()
            .ok_or("test Durable Object invalid")?
            .clone();
        let binding = value
            .remove("binding")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or("test Durable Object binding missing")?;
        durable.insert(binding, Value::Object(value));
    }
    worker["durableObjects"] = Value::Object(durable);
    for key in ["queueProducers", "queueConsumers", "serviceBindings"] {
        if let Some(value) = input.get(key) {
            worker[key] = value.clone();
        }
    }
    if input["denyOutbound"] == true {
        worker["outboundService"] = json!({"network":{"allow":[]}});
    }
    Ok(worker)
}
fn test_worker_options(input: &Value) -> Result<Value> {
    let companions = input["companionWorkers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let declared = std::iter::once(input)
        .chain(companions.iter())
        .collect::<Vec<_>>();
    validate_test_workers(&declared)?;
    if input["d1PersistenceRequired"] == true {
        test_required_storage(&input["d1Persist"])?;
        if declared.iter().any(|worker| {
            worker["durableObjects"]
                .as_array()
                .is_some_and(|v| !v.is_empty())
        }) {
            test_required_storage(&input["durableObjectsPersist"])?;
        }
    }
    let name = input["workerName"]
        .as_str()
        .ok_or("test worker name missing")?;
    let handle = format!("test-mf-{}", random_id()?);
    let main = test_worker_fields(input)?;
    let plan = bindings::Plan {
        app: None,
        bindings: vec![],
        queue_handlers: vec![],
        no_model_storage_mode: None,
    };
    let (mut payload, _) = runtime::options(&handle, name, main, &plan, None, false)?;
    let options = &mut payload["options"];
    // Raw SDK fixtures retain their explicitly selected workerd contract.
    options["workers"][1]["compatibilityDate"] = input["compatibilityDate"].clone();
    options["workers"][1]["compatibilityFlags"] = input
        .get("compatibilityFlags")
        .cloned()
        .unwrap_or(json!([]));
    for key in [
        "d1Persist",
        "r2Persist",
        "kvPersist",
        "durableObjectsPersist",
    ] {
        if let Some(value) = input.get(key) {
            options[key] = value.clone();
        }
    }
    let companions = input["companionWorkers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for companion in &companions {
        options["workers"]
            .as_array_mut()
            .unwrap()
            .push(test_worker_fields(companion)?);
    }
    test_analytics(input, &companions, &mut payload)?;
    Ok(payload)
}

fn validate_test_workers(declared: &[&Value]) -> Result<()> {
    let mut names = BTreeSet::new();
    for worker in declared {
        let name = worker["workerName"]
            .as_str()
            .ok_or("test worker name missing")?;
        if !names.insert(name) {
            return Err(format!("local SDK worker {name} is duplicated"));
        }
    }
    for worker in declared {
        for target in worker["serviceBindings"]
            .as_object()
            .into_iter()
            .flat_map(|v| v.values())
        {
            let name = target
                .as_str()
                .or_else(|| target["name"].as_str())
                .ok_or("test service worker name missing")?;
            if !names.contains(name) {
                return Err(format!(
                    "local SDK service worker {name} has no supplied implementation"
                ));
            }
        }
        for object in worker["durableObjects"].as_array().into_iter().flatten() {
            if let Some(name) = object["scriptName"].as_str() {
                if !names.contains(name) {
                    return Err(format!(
                        "local SDK Durable Object worker {name} has no supplied implementation"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn test_analytics(input: &Value, companions: &[Value], payload: &mut Value) -> Result<()> {
    let options = &mut payload["options"];
    let workers = std::iter::once(input)
        .chain(companions.iter())
        .collect::<Vec<_>>();
    let mut datasets = BTreeSet::new();
    let mut analytics_workers = BTreeSet::new();
    let analytics_name = format!("test-analytics-{}", random_id()?);
    for declared in workers {
        let worker_name = declared["workerName"]
            .as_str()
            .ok_or("test worker name missing")?;
        let index = options["workers"]
            .as_array()
            .unwrap()
            .iter()
            .position(|w| w["name"] == worker_name)
            .ok_or("test worker unavailable")?;
        for item in declared["analyticsEngineDatasets"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let binding = item["binding"]
                .as_str()
                .ok_or("test analytics binding missing")?;
            let dataset = item["dataset"]
                .as_str()
                .ok_or("test analytics dataset missing")?;
            options["workers"][index]["wrappedBindings"][binding] = json!({"scriptName":analytics_name,"bindings":{"dataset":dataset,"workerName":worker_name}});
            datasets.insert(dataset.to_owned());
            analytics_workers.insert(worker_name.to_owned());
        }
    }
    if !datasets.is_empty() {
        let temporary = std::env::temp_dir().join(format!("can-sdk-analytics-{}", random_id()?));
        let path = input["analyticsEnginePersist"]
            .as_str()
            .map(Path::new)
            .unwrap_or(&temporary);
        state::create_private_directory(path)?;
        options["workers"].as_array_mut().unwrap().push(json!({"name":analytics_name,"modules":[{"type":"ESModule","path":"analytics.js","contents":include_str!("preview/analytics.js")}],"serviceBindings":{}}));
        let paths = datasets
            .iter()
            .map(|dataset| {
                (
                    dataset.clone(),
                    path.join(format!("{}.jsonl", capture::hash(dataset.as_bytes()))),
                )
            })
            .collect::<BTreeMap<_, _>>();
        payload["analytics"] = json!({"worker":analytics_name,"datasets":datasets,"workers":analytics_workers,"sinkPaths":paths,"maxBodyBytes":65536});
        if input["analyticsEnginePersist"].is_null() {
            payload["temporaryPaths"] = json!([path]);
        }
    }
    Ok(())
}

fn test_required_storage(value: &Value) -> Result<()> {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let path = value
        .as_str()
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .ok_or("required D1 storage must be an existing absolute directory")?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "required D1 storage directory is unavailable")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.mode() & 0o222 == 0 {
        return Err("required D1 storage is unavailable or unwritable".into());
    }
    let probe = path.join(format!(".can-storage-probe-{}", random_id()?));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&probe)
        .map_err(|_| "required D1 storage is unavailable or unwritable")?;
    let result = file
        .write_all(b"storage preflight\n")
        .and_then(|_| file.sync_all());
    drop(file);
    let removed = fs::remove_file(probe);
    result
        .and(removed)
        .map_err(|_| "required D1 storage is unavailable or unwritable".into())
}
