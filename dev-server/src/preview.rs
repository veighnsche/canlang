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
    admit(capture, artifact)?;
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
    let ast = artifact["modules"][0]["js"]
        .as_str()
        .map(|source| bridge.call("metadata.parse", json!({"source":source})))
        .transpose()?;
    let plan = bindings::plan(artifact, ast.as_ref())?;
    let mode = plan
        .no_model_storage_mode
        .clone()
        .unwrap_or(storage_mode(artifact)?);
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
        {
            return Err(
                "PROFILE_UNSUPPORTED: only checked selected queue handlers are admitted".into(),
            );
        }
    }
    // Service requirements fail before any state is allocated.
    runtime::bindings(&plan, "unused", true)?;
    let roles = parse_roles(preview_roles)?;
    let constants = bridge.call("runtime.constants", json!({}))?;
    if artifact["language_version"] != "1.0"
        || artifact["tool_version"] != constants["releaseVersion"]
    {
        return Err(
            "VERSION_MISMATCH: compiled app does not match installed runtime release".into(),
        );
    }
    let app = match &plan.app {
        Some(app) => app.clone(),
        None => app_name(&capture.source_text)?,
    };
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
    let esbuild = capture
        .inputs
        .iter()
        .find(|i| i.name == "extra:esbuild" && i.state == "present")
        .and_then(|i| i.canonical_path.as_ref())
        .ok_or("BUNDLE_INPUTS_INCOMPLETE: captured esbuild is unavailable")?;
    let reply=bridge.call("bundle.build",json!({"artifactJson":artifact_json,"verdict":{"active":true},"assets":{"browser":true,"valuesWasm":artifact["requires"].as_array().unwrap().iter().any(|r|r["capability"].as_str().unwrap_or("").starts_with("values."))},"esbuildBinaryPath":esbuild}))?;
    let bundle = bundle::verify(&artifact_json, &reply)?;
    bridge.call("bundle.assert",json!({"modules":bundle["modules"],"binaryKeys":bundle["binaries"].as_object().unwrap().keys().collect::<Vec<_>>()}))?;
    let mut retained = persistence_root
        .map(|root| state::Retained::open(root, capture, &artifact_json, &mode))
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
        let resolved = if roles.is_empty() {
            roles
        } else {
            let work_dir = std::env::temp_dir().join(format!("can-preview-roles-{}", random_id()?));
            (bridge.call)(
                "resource.paths",
                Some(generation),
                json!({"temporary":work_dir}),
                &AtomicBool::new(false),
            )?;
            state::create_private_directory(&work_dir)?;
            let definition = bridge.call(
                "semantic.appDefinition",
                json!({"artifactJson":artifact_json,"sourcePath":capture.app_path,"workDir":work_dir}),
            )?;
            resolve_roles(roles, &definition)?
        };
        let seed = seed(&bridge, &provision_handle, &provision_name, &resolved)?;
        if let Some(retained) = &mut retained {
            retained.save_seed(seed.clone())?;
        }
        seed
    };
    bridge.call("mf.dispose", json!({"handle":provision_handle}))?;
    validate_seed(&seed)?;
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
    for owner in &owners {
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
fn admit(capture: &Capture, artifact: &Value) -> Result<()> {
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
    if artifact["pages"].as_array().map_or(0, Vec::len) == 0
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
    let get = |path: &str, headers: &[(&str, &str)]| {
        http::request(backend, origin, path, "GET", headers, vec![], bridge.cancel)
    };
    let post = |path: &str, headers: &[(&str, &str)], body: Value| {
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
    };
    let auth = get("/auth/login", &[])?;
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
    let login = post(
        "/auth/login",
        &[("cookie", &presession)],
        json!({"email":seed["probe"]["email"],"password":seed["probe"]["password"],"_presession":token}),
    )?;
    if login.status != 200 {
        return Err("IDENTITY_UNAVAILABLE: seeded member login refused".into());
    }
    let cookie = login.cookie("can_session")?;
    let csrf = bridge.call("identity.csrf", json!({"cookie":cookie}))?;
    let csrf = csrf["csrf"]
        .as_str()
        .or_else(|| csrf.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Identity current CSRF missing")?;
    let headers = [("cookie", cookie.as_str()), ("x-csrf-token", csrf)];
    let selection = post(
        "/auth/select-team",
        &headers,
        json!({"team":seed["probe"]["teamId"],"_csrf":csrf}),
    )?;
    if selection.status != 200 {
        return Err("IDENTITY_UNAVAILABLE: seeded member team selection refused".into());
    }
    let grant = post(
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
    let authorization = format!("Bearer {grant_token}");
    let discovery = post(
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
    let anonymous = post(
        "/mcp",
        &[("accept", "application/json, text/event-stream")],
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
    )?;
    if anonymous.status != 401 || !anonymous.content_type("application/json") {
        return Err("MCP_UNAVAILABLE: anonymous business MCP caller was not refused".into());
    }
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
        let response = get(&path, &[])?;
        if response.status != 200
            || !response.content_type(resource["contentType"].as_str().unwrap())
            || response.body != bundle::bytes(&resource["bytes"])?
        {
            return Err(format!(
                "RESOURCE_INVALID: installed Worker did not serve packaged {key} bytes"
            ));
        }
    }
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
        let response = get(path, &[("cookie", &cookie)])?;
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
