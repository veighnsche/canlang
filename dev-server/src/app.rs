//! Native entry wiring. The TypeScript install entry remains until T17 parity.
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
            },
            capture: self.capture,
            mode: self.mode,
            preview_roles: self.preview_roles,
        }
    }
}

pub fn run(argv: Vec<String>) -> u8 {
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
        let mut help = serde_json::to_value(cli::help())
            .map_err(|e| fail("CONTROL_INTERNAL", e.to_string()))?;
        help["result"]["unavailable"] = json!([
            "construct.help",
            "construct.rank",
            "rank.lookup",
            "failure.lookup",
            "failure.detail",
            "failures",
            "example.run",
            "example.rerun"
        ]);
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
    let mode = match args.value("--check-mode").unwrap_or("manual") {
        "manual" => CheckMode::Manual,
        "auto" => CheckMode::Automatic,
        _ => {
            return Err(fail(
                "INVALID_ARGUMENTS",
                "check mode must be manual or auto",
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
    let node = std::env::var_os("CAN_DEV_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));
    let host_script = bridge_script(&capture.checkout_root)?;
    Ok(StartConfig {
        capture,
        app,
        mode,
        preview_roles,
        node,
        host_script,
    })
}
fn source_capture(args: &Args) -> Result<CaptureRequest> {
    let root = root(args)?;
    let path = |name: &str, env: &str, fallback: &str| -> String {
        root.join(
            args.value(name)
                .map(PathBuf::from)
                .or_else(|| std::env::var_os(env).map(PathBuf::from))
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
        ),
        catalog_path: Some(path(
            "--catalog",
            "CAN_CATALOG",
            "packages/values/dist/catalog.json",
        )),
        help_index_path: path(
            "--help-index",
            "CAN_DEV_HELP_INDEX",
            "docs/specification/CONSTRUCT-HELP.md",
        ),
        package_input_paths: vec![],
        extra_input_paths: vec![],
        semantic_options: BTreeMap::new(),
        input_inventory: Some("installed-local-preview".into()),
    })
}
fn read_capture(path: &str) -> Result<CaptureRequest> {
    let metadata = fs::metadata(path).map_err(io)?;
    if metadata.len() > 1024 * 1024 {
        return Err(fail(
            "INVALID_CAPTURE",
            "capture manifest exceeds input limit",
        ));
    }
    let mut capture: CaptureRequest = serde_json::from_slice(&fs::read(path).map_err(io)?)
        .map_err(|e| fail("INVALID_CAPTURE", e.to_string()))?;
    let root = fs::canonicalize(&capture.checkout_root).map_err(io)?;
    capture.checkout_root = root.to_string_lossy().into();
    capture.app_path = root.join(&capture.app_path).to_string_lossy().into();
    Ok(capture)
}
fn app_name(path: &Path) -> Result<String> {
    if fs::metadata(path).map_err(io)?.len() > 8 * 1024 * 1024 {
        return Err(fail("INVALID_SELECTION", "source too large; pass --app"));
    }
    let source = fs::read_to_string(path).map_err(io)?;
    let apps: Vec<_> = source
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim_start().split_whitespace();
            (parts.next() == Some("app"))
                .then(|| parts.next())
                .flatten()
                .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
                .map(str::to_owned)
        })
        .collect();
    if apps.len() == 1 {
        Ok(apps[0].clone())
    } else {
        Err(fail(
            "INVALID_SELECTION",
            "source needs one app declaration or --app",
        ))
    }
}
fn bridge_script(root: &str) -> Result<PathBuf> {
    let path = std::env::var_os("CAN_DEV_RUNTIME_HOST")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(root).join("packages/cloudflare/dist/dev/runtime-host.js"));
    fs::canonicalize(path).map_err(|_| {
        fail(
            "RUNTIME_UNAVAILABLE",
            "build the local Cloudflare runtime bridge before starting the native owner",
        )
    })
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
