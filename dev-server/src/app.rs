//! Native command entry wiring and SDK host selection.
use crate::{
    capture::CaptureRequest,
    claim::{self, Lookup, Selection},
    cli::{self, Args, Envelope},
    control::{Client, Command},
    model::{CheckMode, Lifecycle},
    owner::{Config, Owner},
    runtime::BridgeConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command as ProcessCommand, Stdio},
    sync::atomic::AtomicBool,
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, claim::ControlError>;
fn fail(code: &str, reason: impl Into<String>) -> claim::ControlError {
    claim::ControlError::new(code, reason)
}
fn io(error: std::io::Error) -> claim::ControlError {
    fail("CONTROL_IO", error.to_string())
}

#[derive(Serialize, Deserialize)]
struct StartConfig {
    capture: CaptureRequest,
    app: String,
    mode: CheckMode,
    preview_roles: Option<Value>,
    node: PathBuf,
    host_script: PathBuf,
    #[serde(default)]
    install_root: Option<PathBuf>,
}
impl StartConfig {
    fn owner(self) -> Config {
        Config {
            selection: Selection {
                checkout_root: self.capture.checkout_root.clone(),
                app: self.app,
                profile: self.capture.profile.clone(),
                runtime_dir: None,
            },
            bridge: BridgeConfig {
                node: self.node,
                host_script: self.host_script,
                cwd: PathBuf::from(&self.capture.checkout_root),
                session_id: String::new(),
                profile: self.capture.profile.clone(),
                startup_timeout: Duration::from_secs(15),
                install_root: self.install_root,
            },
            capture: self.capture,
            mode: self.mode,
            preview_roles: self.preview_roles,
        }
    }
}

pub fn run(argv: Vec<String>) -> u8 {
    if argv.first().is_some_and(|a| a == "policy-api") {
        return crate::policy::run();
    }
    if argv.first().is_some_and(|a| a == "test-api") {
        return crate::test_support::run();
    }
    if argv
        .first()
        .is_some_and(|a| matches!(a.as_str(), "examples-artifact" | "producer-current"))
    {
        return crate::artifact::run(&argv);
    }
    if argv.first().is_some_and(|a| a == "__owner") {
        crate::signals::install();
        return daemon_entry(&argv[1..]);
    }
    let args = match cli::parse(&argv) {
        Ok(args) => args,
        Err(envelope) => return output(envelope),
    };
    if args.command == "version" {
        println!("can-dev {} (can.dev.control.v1)", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    if args.command == "ui" {
        crate::signals::install();
        return match terminal(&args) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!(
                    "{}",
                    crate::presentation::terminal_text(&e.to_string(), 2000)
                );
                1
            }
        };
    }
    let result = dispatch(&args);
    output(match result {
        Ok((session, result)) => Envelope::success(&args.command, session, result),
        Err(error) => Envelope::failure(&args.command, error.code, error.message),
    })
}
fn output(envelope: Envelope) -> u8 {
    let formatted = cli::format(&envelope);
    print!("{}", formatted.line);
    formatted.exit_code
}
fn dispatch(args: &Args) -> Result<(Option<String>, Value)> {
    if args.command == "help" {
        let help = serde_json::to_value(cli::help())
            .map_err(|e| fail("CONTROL_INTERNAL", e.to_string()))?;
        return Ok((None, help["result"].clone()));
    }
    if args.command == "start" {
        return start(args);
    }
    let client = Client::discover(&lookup(args)?)?;
    let session = Some(client.identity.session_id.clone());
    if args.command == "discover" {
        let status = client.request(command("status", Value::Null), &AtomicBool::new(false))?;
        return Ok((
            session,
            json!({"schema":"can.dev.discover.v1","root":client.identity.root,"status":status}),
        ));
    }
    if args.command == "stop" {
        stop(&client)?;
        return Ok((session, json!({"schema":"can.dev.stop.v1","stopped":true})));
    }
    let result = client.request(
        command(&args.command, cli::payload(args)),
        &AtomicBool::new(false),
    )?;
    Ok((session, result))
}
fn command(name: &str, payload: Value) -> Command {
    Command {
        command: name.into(),
        payload,
    }
}
fn root(args: &Args) -> Result<PathBuf> {
    fs::canonicalize(args.value("--root").unwrap_or(".")).map_err(io)
}
fn lookup(args: &Args) -> Result<Lookup> {
    Ok(Lookup {
        checkout_root: root(args)?.to_string_lossy().into(),
        app: args.value("--app").map(str::to_owned),
        profile: args.value("--profile").map(str::to_owned),
        session_id: args.value("--session").map(str::to_owned),
        runtime_dir: None,
    })
}
fn selected_lookup(config: &StartConfig) -> Lookup {
    Lookup {
        checkout_root: config.capture.checkout_root.clone(),
        app: Some(config.app.clone()),
        profile: Some(config.capture.profile.clone()),
        session_id: None,
        runtime_dir: None,
    }
}
fn existing(config: &StartConfig) -> Result<Option<Client>> {
    match Client::discover(&selected_lookup(config)) {
        Ok(client) => {
            verify_selection(&client, config)?;
            Ok(Some(client))
        }
        Err(error)
            if matches!(
                error.code.as_str(),
                "SESSION_NOT_FOUND" | "ENDPOINT_UNAVAILABLE" | "CONTROL_IO" | "INVALID_DESCRIPTOR"
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
fn verify_selection(client: &Client, config: &StartConfig) -> Result<()> {
    let observed = client.request(command("observe", Value::Null), &AtomicBool::new(false))?;
    if observed["sourcePath"] != config.capture.app_path || observed["mode"] != json!(config.mode) {
        return Err(fail(
            "SESSION_SELECTION_CONFLICT",
            "existing owner uses a different source or check mode",
        ));
    }
    Ok(())
}
fn start(args: &Args) -> Result<(Option<String>, Value)> {
    let config = config(args)?;
    let (client, attached) = match existing(&config)? {
        Some(client) => (client, true),
        None => (launch(config)?, false),
    };
    let status = client.request(command("status", Value::Null), &AtomicBool::new(false))?;
    Ok((
        Some(client.identity.session_id.clone()),
        json!({"schema":"can.dev.start.v1","attached":attached,"root":client.identity.root,"status":status}),
    ))
}
fn terminal(args: &Args) -> Result<()> {
    if args.value("--help") == Some("true") {
        eprintln!(
            "can dev ui [--source PATH | --capture PATH] [start/selection flags] [--plain]\nWithout source or capture, attach to the verified selected owner. Checks are manual by default.\n{}",
            crate::input::HELP
        );
        return Ok(());
    }
    let plain = args.value("--plain") == Some("true");
    if args.value("--source").is_none() && args.value("--capture").is_none() {
        return crate::foreground::run_attached(Client::discover(&lookup(args)?)?, plain)
            .map_err(|e| fail("TERMINAL_FAILED", e));
    }
    let config = config(args)?;
    if let Some(client) = existing(&config)? {
        return crate::foreground::run_attached(client, plain)
            .map_err(|e| fail("TERMINAL_FAILED", e));
    }
    if config.mode != CheckMode::Manual {
        return Err(fail(
            "CHECK_MODE_UNAVAILABLE",
            "native automatic scheduling has not completed T19",
        ));
    }
    let owner = Owner::start(config.owner())?;
    owner.request(command("check.request", Value::Null))?;
    crate::foreground::run_owned(owner, plain).map_err(|e| fail("TERMINAL_FAILED", e))
}
fn config(args: &Args) -> Result<StartConfig> {
    let capture = if let Some(path) = args.value("--capture") {
        read_capture(path)?
    } else {
        source_capture(args)?
    };
    let source = Path::new(&capture.checkout_root).join(&capture.app_path);
    let app = args
        .value("--app")
        .map(str::to_owned)
        .map(Ok)
        .unwrap_or_else(|| app_name(&source))?;
    validate_selection(&capture, &app, &source)?;
    let mode = match args.value("--check-mode").unwrap_or("manual") {
        "manual" => CheckMode::Manual,
        "automatic" => CheckMode::Automatic,
        _ => {
            return Err(fail(
                "INVALID_ARGUMENTS",
                "check mode must be manual or automatic",
            ));
        }
    };
    if mode != CheckMode::Manual {
        return Err(fail(
            "CHECK_MODE_UNAVAILABLE",
            "native automatic scheduling has not completed T19",
        ));
    }
    let preview_roles = args
        .value("--preview-roles")
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| fail("INVALID_ARGUMENTS", e.to_string()))?;
    let install_root = installation()?;
    let node = std::env::var_os("CAN_DEV_NODE")
        .map(PathBuf::from)
        .or_else(|| install_root.as_ref().map(|root| root.join("libexec/node")))
        .unwrap_or_else(|| PathBuf::from("node"));
    let host_script = bridge_script(&capture.checkout_root)?;
    Ok(StartConfig {
        capture,
        app,
        mode,
        preview_roles,
        node,
        host_script,
        install_root,
    })
}
pub(crate) fn artifact_config(root: &Path, source: &str) -> Result<Config> {
    let root = root
        .to_str()
        .ok_or_else(|| fail("INVALID_ARGUMENTS", "project root is not UTF-8"))?;
    config(&Args {
        command: "start".into(),
        values: BTreeMap::from([
            ("--root".into(), root.into()),
            ("--source".into(), source.into()),
        ]),
    })
    .map(StartConfig::owner)
}
pub(crate) fn helper_bridge(root: &Path, session: String) -> Result<BridgeConfig> {
    let install_root = installation()?;
    Ok(BridgeConfig {
        node: std::env::var_os("CAN_DEV_NODE")
            .map(PathBuf::from)
            .or_else(|| install_root.as_ref().map(|r| r.join("libexec/node")))
            .unwrap_or_else(|| "node".into()),
        host_script: bridge_script(
            root.to_str()
                .ok_or_else(|| fail("INVALID_ARGUMENTS", "helper root is not UTF-8"))?,
        )?,
        cwd: root.into(),
        session_id: session,
        profile: "local-d1-identity".into(),
        startup_timeout: Duration::from_secs(15),
        install_root,
    })
}
fn source_capture(args: &Args) -> Result<CaptureRequest> {
    let root = root(args)?;
    let install_root = installation()?;
    let path = |name: &str, env: &str, fallback: &str, installed: &str| -> String {
        root.join(
            args.value(name)
                .map(PathBuf::from)
                .or_else(|| configured_input(env))
                .or_else(|| install_root.as_ref().map(|root| root.join(installed)))
                .unwrap_or_else(|| PathBuf::from(fallback)),
        )
        .to_string_lossy()
        .into()
    };
    let source = args
        .value("--source")
        .ok_or_else(|| fail("INVALID_ARGUMENTS", "source path required"))?;
    Ok(CaptureRequest {
        checkout_root: root.to_string_lossy().into(),
        app_path: root.join(source).to_string_lossy().into(),
        profile: "local-d1-identity".into(),
        compiler_path: path(
            "--compiler",
            "CAN_DEV_COMPILER",
            "compiler/target/debug/can",
            "libexec/can",
        ),
        catalog_path: Some(path(
            "--catalog",
            "CAN_CATALOG",
            "packages/values/dist/catalog.json",
            "node_modules/@canlang/values/dist/catalog.json",
        )),
        help_index_path: path(
            "--help-index",
            "CAN_HELP_INDEX",
            "docs/specification/CONSTRUCT-HELP.md",
            "docs/specification/CONSTRUCT-HELP.md",
        ),
        package_input_paths: vec![],
        extra_input_paths: vec![],
        semantic_options: BTreeMap::new(),
        input_inventory: Some("installed-local-preview".into()),
    })
}
fn read_capture(path: &str) -> Result<CaptureRequest> {
    let unavailable = || {
        fail(
            "CAPTURE_FILE_UNAVAILABLE",
            "capture manifest cannot be read",
        )
    };
    let metadata = fs::metadata(path).map_err(|_| unavailable())?;
    if metadata.len() > 1024 * 1024 {
        return Err(fail(
            "INVALID_CAPTURE",
            "capture manifest exceeds input limit",
        ));
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|_| unavailable())?)
        .map_err(|e| fail("INVALID_CAPTURE", e.to_string()))?;
    if !value
        .get("catalogPath")
        .is_some_and(|v| v.is_null() || v.is_string())
    {
        return Err(fail(
            "INVALID_CAPTURE",
            "catalogPath must be explicitly null or a path",
        ));
    }
    let mut capture: CaptureRequest =
        serde_json::from_value(value).map_err(|e| fail("INVALID_CAPTURE", e.to_string()))?;
    if capture.catalog_path.is_none()
        || (capture.package_input_paths.is_empty()
            && capture.input_inventory.as_deref() != Some("installed-local-preview"))
    {
        return Err(fail(
            "CAPTURE_INCOMPLETE",
            "compiler catalog and package input inventory are required",
        ));
    }
    let root = fs::canonicalize(&capture.checkout_root).map_err(io)?;
    capture.checkout_root = root.to_string_lossy().into();
    capture.app_path = root.join(&capture.app_path).to_string_lossy().into();
    Ok(capture)
}
fn identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn source_apps(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start_matches([' ', '\t']).strip_prefix("app")?;
            if !rest.starts_with([' ', '\t']) {
                return None;
            }
            let name: String = rest
                .trim_start_matches([' ', '\t'])
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            identifier(&name).then_some(name)
        })
        .collect()
}
fn source_text(path: &Path) -> Result<String> {
    let unavailable = || fail("SOURCE_UNAVAILABLE", "selected source cannot be read");
    if fs::metadata(path).map_err(|_| unavailable())?.len() > 8 * 1024 * 1024 {
        return Err(fail("INVALID_SELECTION", "source too large; pass --app"));
    }
    fs::read_to_string(path).map_err(|_| unavailable())
}
fn app_name(path: &Path) -> Result<String> {
    let apps = source_apps(&source_text(path)?);
    if apps.len() == 1 {
        Ok(apps[0].clone())
    } else {
        Err(fail(
            "INVALID_SELECTION",
            "source needs one app declaration or --app",
        ))
    }
}
fn validate_selection(capture: &CaptureRequest, app: &str, source: &Path) -> Result<()> {
    if !identifier(app) {
        return Err(fail(
            "INVALID_SELECTION",
            "selected app must be one Can identifier",
        ));
    }
    if capture.profile != "local-d1-identity" {
        return Err(fail(
            "PROFILE_UNSUPPORTED",
            "the local D1 and Identity profile is the only daemon profile",
        ));
    }
    if source_apps(&source_text(source)?)
        .first()
        .map(String::as_str)
        != Some(app)
    {
        return Err(fail(
            "SELECTION_MISMATCH",
            "selected app differs from the captured source declaration",
        ));
    }
    Ok(())
}
fn bridge_script(root: &str) -> Result<PathBuf> {
    let install_root = installation()?;
    let path = std::env::var_os("CAN_DEV_RUNTIME_HOST")
        .map(PathBuf::from)
        .or_else(|| install_root.map(|root| root.join("libexec/dev-server-host/entry.mjs")))
        .unwrap_or_else(|| Path::new(root).join("dev-server/host/entry.mjs"));
    fs::canonicalize(path).map_err(|_| {
        fail(
            "RUNTIME_UNAVAILABLE",
            "the native development SDK host entry is unavailable",
        )
    })
}
fn configured_input(name: &str) -> Option<PathBuf> {
    let alias = match name {
        "CAN_DEV_COMPILER" => "CAN_COMPILER_BIN",
        "CAN_HELP_INDEX" => "CAN_DEV_HELP_INDEX",
        _ => name,
    };
    std::env::var_os(name)
        .or_else(|| std::env::var_os(alias))
        .map(PathBuf::from)
}
fn installation() -> Result<Option<PathBuf>> {
    let executable = std::env::current_exe().map_err(io)?;
    let sibling = executable
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "libexec"))
        .and_then(Path::parent)
        .filter(|p| p.join("manifest.json").is_file())
        .map(Path::to_owned);
    let selected = std::env::var_os("CAN_INSTALL_ROOT")
        .map(PathBuf::from)
        .or(sibling);
    selected
        .map(|root| validate_installation(&root))
        .transpose()
}
fn validate_installation(root: &Path) -> Result<PathBuf> {
    let unavailable = || {
        fail(
            "INSTALLATION_INVALID",
            "native development tools require a valid Can installation",
        )
    };
    let root = fs::canonicalize(root).map_err(|_| unavailable())?;
    let path = root.join("manifest.json");
    if fs::metadata(&path).map_err(|_| unavailable())?.len() > 1024 * 1024 {
        return Err(unavailable());
    }
    let manifest: Value = serde_json::from_slice(&fs::read(path).map_err(|_| unavailable())?)
        .map_err(|_| unavailable())?;
    if manifest["kind"] != "can-install" {
        return Err(unavailable());
    }
    Ok(root)
}
fn launch(config: StartConfig) -> Result<Client> {
    let directory = tempfile::Builder::new()
        .prefix("can-dev-launch-")
        .tempdir()
        .map_err(io)?;
    let path = directory.path().join("owner.json");
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .map_err(io)?;
    file.write_all(
        &serde_json::to_vec(&config).map_err(|e| fail("INVALID_CAPTURE", e.to_string()))?,
    )
    .map_err(io)?;
    drop(file);
    let lookup = selected_lookup(&config);
    let mut spawn = ProcessCommand::new(std::env::current_exe().map_err(io)?);
    spawn
        .arg("__owner")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        spawn.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = spawn.spawn().map_err(io)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(client) = Client::discover(&lookup) {
            verify_selection(&client, &config)?;
            return Ok(client);
        }
        if child.try_wait().map_err(io)?.is_some() {
            return Err(fail(
                "START_FAILED",
                "native owner exited before verified discovery",
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(fail(
                "START_TIMEOUT",
                "native owner did not publish a verified endpoint",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn daemon_entry(argv: &[String]) -> u8 {
    let result = (|| -> Result<()> {
        if argv.len() != 1 {
            return Err(fail(
                "INVALID_ARGUMENTS",
                "private owner needs one configuration path",
            ));
        }
        let metadata = fs::symlink_metadata(&argv[0]).map_err(io)?;
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_file()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::getuid() }
            || metadata.len() > 1024 * 1024
        {
            return Err(fail(
                "INVALID_CAPTURE",
                "private owner configuration is not bounded and owner-only",
            ));
        }
        let config: StartConfig = serde_json::from_slice(&fs::read(&argv[0]).map_err(io)?)
            .map_err(|e| fail("INVALID_CAPTURE", e.to_string()))?;
        let owner = Owner::start(config.owner())?;
        loop {
            if crate::signals::take() {
                let _ = owner.request(command("stop.confirm", Value::Null));
            }
            if owner.snapshot().lifecycle == Lifecycle::Stopped {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        owner.join()
    })();
    if result.is_ok() { 0 } else { 1 }
}
fn stop(client: &Client) -> Result<()> {
    client.request(
        command("stop.confirm", Value::Null),
        &AtomicBool::new(false),
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let endpoint = Path::new(&client.identity.socket_path).exists();
        let alive = unsafe { libc::kill(client.identity.pid as i32, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        if !endpoint && !alive {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(fail(
        "STOP_UNCONFIRMED",
        "resources released; endpoint/process retirement has not been confirmed",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn implicit_app_selection_matches_declared_identifier_boundaries() {
        assert_eq!(
            source_apps("  app Office{\n app_ignored Wrong\n\tapp _Other "),
            ["Office", "_Other"]
        );
        assert!(source_apps("app 1Invalid\n## app Comment\napple Other").is_empty());
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("App.can");
        fs::write(&source, "app Office {\n").unwrap();
        assert_eq!(app_name(&source).unwrap(), "Office");
        fs::write(&source, "app Office\napp Other\n").unwrap();
        assert_eq!(app_name(&source).unwrap_err().code, "INVALID_SELECTION");
        assert_eq!(
            app_name(&root.path().join("absent.can")).unwrap_err().code,
            "SOURCE_UNAVAILABLE"
        );
    }

    #[test]
    fn capture_manifest_and_selection_fail_with_specific_control_codes() {
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join("capture.json");
        assert_eq!(
            read_capture(manifest.to_str().unwrap()).unwrap_err().code,
            "CAPTURE_FILE_UNAVAILABLE"
        );
        fs::write(&manifest, "not JSON").unwrap();
        assert_eq!(
            read_capture(manifest.to_str().unwrap()).unwrap_err().code,
            "INVALID_CAPTURE"
        );
        let source = root.path().join("App.can");
        fs::write(&source, "app Office\n").unwrap();
        let mut capture = CaptureRequest {
            checkout_root: root.path().to_string_lossy().into(),
            app_path: "App.can".into(),
            profile: "local-d1-identity".into(),
            compiler_path: "compiler".into(),
            catalog_path: Some("catalog".into()),
            help_index_path: "help".into(),
            package_input_paths: vec![],
            extra_input_paths: vec![],
            semantic_options: BTreeMap::new(),
            input_inventory: None,
        };
        let mut value = serde_json::to_value(&capture).unwrap();
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            read_capture(manifest.to_str().unwrap()).unwrap_err().code,
            "CAPTURE_INCOMPLETE"
        );
        value.as_object_mut().unwrap().remove("catalogPath");
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            read_capture(manifest.to_str().unwrap()).unwrap_err().code,
            "INVALID_CAPTURE"
        );
        capture.input_inventory = Some("installed-local-preview".into());
        fs::write(&manifest, serde_json::to_vec(&capture).unwrap()).unwrap();
        assert_eq!(
            read_capture(manifest.to_str().unwrap()).unwrap().profile,
            "local-d1-identity"
        );
        validate_selection(&capture, "Office", &source).unwrap();
        assert_eq!(
            validate_selection(&capture, "Other", &source)
                .unwrap_err()
                .code,
            "SELECTION_MISMATCH"
        );
        assert_eq!(
            validate_selection(&capture, "1Office", &source)
                .unwrap_err()
                .code,
            "INVALID_SELECTION"
        );
        capture.profile = "foreign".into();
        assert_eq!(
            validate_selection(&capture, "Office", &source)
                .unwrap_err()
                .code,
            "PROFILE_UNSUPPORTED"
        );
    }

    #[test]
    fn help_dispatch_is_nonstarting_and_advertises_the_complete_command_surface() {
        let args = cli::parse(&[]).unwrap();
        let (session, result) = dispatch(&args).unwrap();
        assert!(session.is_none());
        assert_eq!(result["unavailable"], json!([]));
        assert_eq!(
            result["commands"].as_array().unwrap().len(),
            cli::COMMANDS.len()
        );
        assert_eq!(
            result["flags"]["start"],
            json!([
                "--source",
                "--root",
                "--app",
                "--compiler",
                "--catalog",
                "--help-index",
                "--capture",
                "--preview-roles",
                "--check-mode"
            ])
        );
    }
}
