//! Real CLI/control -> native owner -> captured compiler -> SDK/Workerd lifecycle.
//! This deliberately does not emulate worker events or manufacture SessionState.
use can_dev_server::{
    claim::Lookup,
    control::{Client, Command as ControlCommand},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::AtomicBool,
    thread,
    time::{Duration, Instant},
};
use url::Url;

#[path = "integration/terminal.rs"]
mod terminal;

const SOURCE: &str = "app SessionLifecycle\nGiven\n Item {title:text}\n policy Item read=members\nWhen\n crud Item by=members fields=title\nThen\n page / title=\"Owner lifecycle\"\n  text \"Owner lifecycle\"\n";

struct Session {
    _directory: tempfile::TempDir,
    root: PathBuf,
    runtime: PathBuf,
    client: Client,
    stopped: bool,
}
impl Session {
    fn start() -> Self {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let directory = tempfile::Builder::new()
            .prefix("cv-life-")
            .tempdir()
            .unwrap();
        let root = directory.path().join("project");
        let runtime = directory
            .path()
            .join(format!("cv-{}", unsafe { libc::getuid() }));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("App.can"), SOURCE).unwrap();
        let compiler = std::env::var_os("CAN_DEV_COMPILER")
            .or_else(|| std::env::var_os("CAN_COMPILER_BIN"))
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace.join("compiler/target/debug/can"));
        assert!(
            compiler.is_file(),
            "build the real compiler or set CAN_COMPILER_BIN"
        );
        let result = Command::new(env!("CARGO_BIN_EXE_can-dev"))
            .args(["start", "--root"])
            .arg(&root)
            .args(["--source", "App.can", "--app", "SessionLifecycle"])
            .env("TMPDIR", directory.path())
            .env("CAN_DEV_STATE_ROOT", directory.path().join("state"))
            .env(
                "CAN_DEV_RUNTIME_HOST",
                workspace.join("dev-server/host/entry.mjs"),
            )
            .env("CAN_DEV_COMPILER", compiler)
            .env(
                "CAN_CATALOG",
                workspace.join("packages/values/dist/catalog.json"),
            )
            .env(
                "CAN_HELP_INDEX",
                workspace.join("docs/specification/CONSTRUCT-HELP.md"),
            )
            .env_remove("CAN_INSTALL_ROOT")
            .env_remove("CAN_TOOL_ROOT")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let envelope: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(envelope["ok"], true, "{envelope}");
        assert_eq!(envelope["result"]["attached"], false);
        let client = Client::discover(&Lookup {
            checkout_root: root.to_str().unwrap().into(),
            app: Some("SessionLifecycle".into()),
            profile: Some("local-d1-identity".into()),
            session_id: envelope["session"].as_str().map(str::to_owned),
            runtime_dir: Some(runtime.clone()),
        })
        .unwrap();
        Self {
            _directory: directory,
            root,
            runtime,
            client,
            stopped: false,
        }
    }
    fn request(&self, command: &str, payload: Value) -> Value {
        self.client
            .request(
                ControlCommand {
                    command: command.into(),
                    payload,
                },
                &AtomicBool::new(false),
            )
            .unwrap_or_else(|error| panic!("{command}: {error}"))
    }
    fn status(&self) -> Value {
        self.request("status", Value::Null)
    }
    fn wait_for_check_admission(&self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let status = self.status();
            if status["observation"]["admission"]["check"] == true {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "previous worker/generation cleanup did not release admission: {status}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        let result = self.request("stop.confirm", Value::Null);
        assert_eq!(result["resourcesReleased"], true);
        let deadline = Instant::now() + Duration::from_secs(10);
        let owner_alive = || unsafe { libc::kill(self.client.identity.pid as i32, 0) } == 0;
        while (Path::new(&self.client.identity.socket_path).exists() || owner_alive())
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !Path::new(&self.client.identity.socket_path).exists(),
            "control listener retired"
        );
        assert!(
            !owner_alive(),
            "confirmed owner process exited after release"
        );
        assert!(
            Client::discover(&Lookup {
                checkout_root: self.root.to_str().unwrap().into(),
                runtime_dir: Some(self.runtime.clone()),
                ..Lookup::default()
            })
            .is_err(),
            "the released owner is no longer discoverable"
        );
        self.stopped = true;
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if !self.stopped {
            // Preserve the original assertion on failure, while releasing actual processes.
            let _ = self.client.request(
                ControlCommand {
                    command: "stop.confirm".into(),
                    payload: Value::Null,
                },
                &AtomicBool::new(false),
            );
            // Confirmation precedes endpoint retirement. Do not remove the
            // fixture's claim directory while the real owner is draining it.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Path::new(&self.client.identity.socket_path).exists() && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn get(url: &Url, cookie: Option<&str>) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let cookie = cookie
        .map(|value| format!("Cookie: {value}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{cookie}Connection: close\r\n\r\n",
        &url[url::Position::BeforePath..],
        url.port().unwrap()
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn real_owner_retains_serving_preview_across_errors_reuses_exact_inputs_and_joins_stop() {
    let mut session = Session::start();
    let before = session.status();
    assert_eq!(
        before["preview"], "unavailable",
        "control readiness is not application readiness"
    );
    let first = session.request("check", Value::Null);
    assert_eq!(first["state"], "valid", "{first}");
    assert_eq!(first["preview"], "ready", "{first}");
    terminal::attached(
        &session.root,
        session._directory.path(),
        &session.client.identity.session_id,
    );
    assert_eq!(
        session.status()["observation"]["lifecycle"],
        "running",
        "attached UI cannot stop its owner"
    );
    let serving = session.status();
    let build = serving["serving_build"].clone();
    assert!(build.is_string());
    let opened = session.request("preview.open", Value::Null);
    let mut url = Url::parse(opened["url"].as_str().unwrap()).unwrap();
    let response = get(&url, None);
    assert!(response.starts_with("HTTP/1.1 303"));
    let cookie = response
        .lines()
        .find_map(|line| line.strip_prefix("set-cookie: "))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    url.set_path("/");
    url.set_query(None);
    let response = get(&url, Some(&cookie));
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response.contains("Owner lifecycle"),
        "actual compiled page is served"
    );

    session.wait_for_check_admission();
    let identical = session.request("check", Value::Null);
    assert_eq!(identical["state"], "valid");
    assert_eq!(
        session.status()["serving_build"],
        build,
        "identical captured inputs reuse the selected generation"
    );

    // Admit replacement previews through the real compiler/SDK/Workerd path while
    // retained metadata is unsafe. Every refusal preserves both state and serving generation.
    let state_root = session._directory.path().join("state");
    let state_directory = fs::read_dir(&state_root)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let manifest = state_directory.join("preview.json");
    let original_metadata = fs::read(&manifest).unwrap();
    assert_eq!(
        fs::metadata(&manifest).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&state_directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let retained: Value = serde_json::from_slice(&original_metadata).unwrap();
    assert!(retained["seed"]["actors"].is_array());
    for fault in ["permissions", "symlink", "schema"] {
        let moved = state_directory.join("retained-original.json");
        let expected = match fault {
            "permissions" => {
                fs::set_permissions(&manifest, fs::Permissions::from_mode(0o644)).unwrap();
                original_metadata.clone()
            }
            "symlink" => {
                fs::rename(&manifest, &moved).unwrap();
                symlink(&moved, &manifest).unwrap();
                original_metadata.clone()
            }
            _ => {
                let mut changed = retained.clone();
                changed["schema"] = json!("0".repeat(64));
                let bytes = serde_json::to_vec(&changed).unwrap();
                fs::write(&manifest, &bytes).unwrap();
                bytes
            }
        };
        fs::write(
            session.root.join("App.can"),
            format!("{SOURCE}## retained admission {fault}\n"),
        )
        .unwrap();
        session.wait_for_check_admission();
        let refused = session.request("check", Value::Null);
        assert_eq!(refused["state"], "valid", "{fault}: {refused}");
        assert_eq!(refused["preview"], "build_failed", "{fault}: {refused}");
        assert_eq!(session.status()["serving_build"], build);
        assert!(get(&url, Some(&cookie)).contains("Owner lifecycle"));
        assert_eq!(
            fs::read(&manifest).unwrap(),
            expected,
            "refused metadata must be preserved"
        );
        if fault == "symlink" {
            fs::remove_file(&manifest).unwrap();
            fs::rename(&moved, &manifest).unwrap();
        } else {
            fs::set_permissions(&manifest, fs::Permissions::from_mode(0o600)).unwrap();
            fs::write(&manifest, &original_metadata).unwrap();
        }
    }

    fs::write(
        session.root.join("App.can"),
        SOURCE.replace("Item {title:text}", "Item {title:missing_type}"),
    )
    .unwrap();
    session.wait_for_check_admission();
    let failed = session.request("check", Value::Null);
    assert_eq!(failed["state"], "errors", "{failed}");
    let stale = session.status();
    assert_eq!(
        stale["serving_build"], build,
        "source errors retain the last actual serving generation"
    );
    assert_eq!(stale["preview"], "ready");
    assert_eq!(stale["stale"], true);
    assert!(get(&url, Some(&cookie)).contains("Owner lifecycle"));
    let revision = failed["revision"].as_str().unwrap();
    let diagnostics = session.request(
        "diagnostics",
        json!({"revision":revision,"after":-1,"limit":1}),
    );
    assert_eq!(diagnostics["revision"], revision);
    assert!(!diagnostics["diagnostics"].as_array().unwrap().is_empty());
    let detail = session.request(
        "diagnostic.detail",
        json!({"revision":revision,"index":0,"presentationOnly":true}),
    );
    assert!(
        detail["captured_excerpt"]
            .to_string()
            .contains("missing_type")
    );
    let invalid = session
        .client
        .request(
            ControlCommand {
                command: "diagnostics".into(),
                payload: json!({"revision":revision,"after":-2}),
            },
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(invalid.code, "INVALID_REQUEST");

    fs::write(session.root.join("App.can"), SOURCE).unwrap();
    session.wait_for_check_admission();
    let restored = session.request("check", Value::Null);
    assert_eq!(restored["state"], "valid", "{restored}");
    assert_eq!(restored["preview"], "ready");
    let active_url = Url::parse(
        session.status()["observation"]["preview"]["origin"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    session.wait_for_check_admission();

    // Stop an admitted real check through the control seam; the native owner
    // cancels/joins its worker and releases both serving and candidate resources.
    fs::write(
        session.root.join("App.can"),
        SOURCE.replace("Owner lifecycle", "Changed lifecycle"),
    )
    .unwrap();
    assert_eq!(
        session.request("check.request", json!({}))["accepted"],
        true
    );
    session.stop();
    assert!(
        TcpStream::connect(("127.0.0.1", active_url.port().unwrap())).is_err(),
        "preview listener closed after confirmed release"
    );
}
