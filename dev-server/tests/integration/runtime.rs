//! Actual runtime boundary integration; assertions run through the public owning API.
use can_dev_server::runtime::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    io::{self},
    path::PathBuf,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
const SCRIPT: &str = r#"
const sessionId=process.argv[process.argv.indexOf('--session')+1];
const protocol='can.dev.runtime.v1';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
send({protocol,kind:'ready',sessionId,pid:process.pid,profile:'local-d1-identity',commands:[...__SDK_COMMANDS__,'inventory','prepare','probe']});
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 const respond=()=>send({protocol,kind:'result',sessionId,operationId:request.operationId,generationId:request.generationId,ok:true,allocation:request.command==='prepare'?'owned':request.command==='release'?'released':'none',result:{command:request.command}});
 if(request.command==='prepare')setTimeout(respond,150);else respond();
});
process.stdin.on('end',()=>process.exit(0));
"#;

fn fixture(script: &str) -> (tempfile::TempDir, BridgeConfig) {
    let directory = tempfile::tempdir().unwrap();
    let host_script = directory.path().join("host.cjs");
    fs::write(
        &host_script,
        script.replace(
            "__SDK_COMMANDS__",
            &serde_json::to_string(
                &[
                    "node.resolve",
                    "runtime.constants",
                    "metadata.parse",
                    "mf.create",
                    "mf.dispose",
                    "mf.scheduled",
                    "d1.query",
                    "r2.put",
                    "r2.get",
                    "r2.delete",
                    "identity.ensureSchema",
                    "identity.createTeam",
                    "identity.createUser",
                    "identity.createMembership",
                    "identity.findUserByEmail",
                    "identity.findTeamById",
                    "identity.setMemberRole",
                    "identity.hashPassword",
                    "identity.csrf",
                    "identity.resolve",
                    "state.ensureSchema",
                    "state.ownerScoped",
                    "state.hashInputs",
                    "semantic.activate",
                    "semantic.appDefinition",
                    "bundle.build",
                    "bundle.assert",
                    "testkit.load",
                    "testkit.row",
                    "testkit.stage",
                    "testkit.report",
                    "testkit.dispose",
                    "browser.executable",
                    "browser.launch",
                    "browser.newContext",
                    "browser.newPage",
                    "browser.goto",
                    "browser.request",
                    "browser.cookies",
                    "browser.locator",
                    "browser.submit",
                    "browser.title",
                    "browser.close",
                    "consume",
                    "cancel",
                    "release",
                    "retry",
                ][..],
            )
            .unwrap(),
        ),
    )
    .unwrap();
    let config = BridgeConfig {
        node: std::env::var_os("CAN_DEV_TEST_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node")),
        host_script,
        cwd: directory.path().into(),
        session_id: "private-test-session".into(),
        profile: "local-d1-identity".into(),
        startup_timeout: Duration::from_secs(3),
        install_root: None,
    };
    (directory, config)
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(3)
}

#[test]
fn ready_identity_profile_and_pid_are_verified_and_failed_spawn_releases() {
    for bad in [
        SCRIPT.replace("pid:process.pid", "pid:1"),
        SCRIPT.replace("profile:'local-d1-identity'", "profile:'wrong'"),
        SCRIPT.replace("__SDK_COMMANDS__", "[]"),
    ] {
        let (_directory, config) = fixture(&bad);
        let error = match Bridge::spawn(config) {
            Ok(_) => panic!("invalid readiness accepted"),
            Err(error) => error,
        };
        assert_eq!(error.kind, ErrorKind::Protocol);
        assert!(
            error.retained.is_none(),
            "cleanup was not confirmed: {error:?}"
        );
    }
}

#[test]
fn concurrent_inventory_does_not_wait_for_prepare_and_drain_does_not_steal_live_reply() {
    let (_directory, config) = fixture(SCRIPT);
    let bridge = Arc::new(Bridge::spawn(config).unwrap());
    let preparing = bridge.clone();
    let worker = thread::spawn(move || {
        preparing
            .request(
                "prepare",
                "prepare-one",
                Some("g1"),
                json!({}),
                deadline(),
                &AtomicBool::new(false),
            )
            .unwrap()
    });
    thread::sleep(Duration::from_millis(20));
    let started = Instant::now();
    let inventory = bridge
        .request(
            "inventory",
            "inventory-one",
            None,
            json!({}),
            deadline(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(inventory.result.unwrap()["command"], "inventory");
    assert!(started.elapsed() < Duration::from_millis(130));
    assert!(bridge.drain_retained().is_empty());
    assert_eq!(worker.join().unwrap().allocation, Allocation::Owned);
    bridge.shutdown(deadline()).unwrap();
    assert_eq!(unsafe { libc::kill(-(bridge.pid() as i32), 0) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
}

#[test]
fn cancellation_and_deadline_preserve_late_allocation_facts() {
    let (_directory, config) = fixture(SCRIPT);
    let bridge = Arc::new(Bridge::spawn(config).unwrap());
    let cancel = Arc::new(AtomicBool::new(false));
    let pending = bridge.clone();
    let cancellation = cancel.clone();
    let worker = thread::spawn(move || {
        pending.request(
            "prepare",
            "cancelled",
            Some("g-cancelled"),
            json!({}),
            deadline(),
            &cancellation,
        )
    });
    thread::sleep(Duration::from_millis(30));
    cancel.store(true, Ordering::Release);
    assert_eq!(
        worker.join().unwrap().unwrap_err().kind,
        ErrorKind::Cancelled
    );
    let timed = bridge.request(
        "prepare",
        "timed-out",
        Some("g-timed-out"),
        json!({}),
        Instant::now() + Duration::from_millis(20),
        &AtomicBool::new(false),
    );
    assert_eq!(timed.unwrap_err().kind, ErrorKind::Deadline);
    thread::sleep(Duration::from_millis(200));
    let retained = bridge.drain_retained();
    assert_eq!(retained.len(), 2);
    assert!(
        retained
            .iter()
            .all(|reply| reply.allocation == Allocation::Owned)
    );
    let released = bridge
        .request(
            "release",
            "release-cancelled",
            Some("g-cancelled"),
            json!({}),
            deadline(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(released.allocation, Allocation::Released);
    bridge.shutdown(deadline()).unwrap();
}

#[test]
fn stderr_is_sanitized_bounded_and_reports_dropped_bytes() {
    let script = format!(
        "process.stderr.write('\\x1b[31mred\\x1b[0m\\u202e'+'x'.repeat(100000));\n{SCRIPT}"
    );
    let (_directory, config) = fixture(&script);
    let bridge = Bridge::spawn(config).unwrap();
    bridge
        .request(
            "inventory",
            "logs",
            None,
            json!({}),
            deadline(),
            &AtomicBool::new(false),
        )
        .unwrap();
    thread::sleep(Duration::from_millis(20));
    let logs = bridge.stderr();
    assert!(logs.text.starts_with("red "));
    assert!(!logs.text.contains('\x1b'));
    assert!(!logs.text.contains('\u{202e}'));
    assert!(logs.text.len() <= MAX_STDERR);
    assert!(logs.dropped_bytes > 0);
    bridge.shutdown(deadline()).unwrap();
}

#[test]
fn mismatched_generation_cannot_complete_request_but_allocation_is_retained() {
    let script = SCRIPT.replace(
        "generationId:request.generationId",
        "generationId:'wrong-generation'",
    );
    let (_directory, config) = fixture(&script);
    let bridge = Bridge::spawn(config).unwrap();
    let error = bridge
        .request(
            "inventory",
            "correlated",
            Some("expected"),
            json!({}),
            deadline(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Protocol);
    let retained = bridge.drain_retained();
    assert_eq!(retained.len(), 1);
    assert_eq!(
        retained[0].generation_id.as_deref(),
        Some("wrong-generation")
    );
    bridge.shutdown(deadline()).unwrap();
}

#[test]
fn host_crash_releases_non_detached_descendant_and_does_not_touch_foreign_group() {
    let script = SCRIPT.replace("const protocol=", "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\nconst protocol=");
    let (_directory, config) = fixture(&script);
    let bridge = Bridge::spawn(config).unwrap();
    let mut foreign = Command::new("sleep").arg("10").spawn().unwrap();
    assert_eq!(unsafe { libc::kill(bridge.pid() as i32, libc::SIGKILL) }, 0);
    let until = deadline();
    while bridge.check_health().is_ok() && Instant::now() < until {
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        bridge.check_health().unwrap_err().kind,
        ErrorKind::Disconnected
    );
    bridge.shutdown(deadline()).unwrap();
    assert!(foreign.try_wait().unwrap().is_none());
    foreign.kill().unwrap();
    foreign.wait().unwrap();
}

#[test]
fn expired_shutdown_retains_same_handle_for_retry() {
    let (_directory, config) = fixture(SCRIPT);
    let bridge = Bridge::spawn(config).unwrap();
    assert_eq!(
        bridge.shutdown(Instant::now()).unwrap_err().kind,
        ErrorKind::Deadline
    );
    bridge.shutdown(deadline()).unwrap();
    bridge.shutdown(deadline()).unwrap();
}

#[test]
fn registered_sdk_tree_keeps_ownership_after_unsafe_release_until_real_cleanup() {
    use can_dev_server::sdk::{self, Resources};
    let (_directory, config) = fixture(SCRIPT);
    let bridge = Bridge::spawn(config).unwrap();
    let tree = tempfile::Builder::new()
        .prefix("can-sdk-release-")
        .tempdir()
        .unwrap();
    let path = fs::canonicalize(tree.path()).unwrap();
    let resources = Resources::default();
    sdk::call(
        &bridge,
        &resources,
        "resource.paths",
        Some("candidate"),
        json!({"temporary":path}),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(resources.owns("candidate"));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(resources.released("candidate").is_err());
    assert!(resources.owns("candidate"));
    assert!(!resources.retired("candidate"));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    resources.released("candidate").unwrap();
    assert!(!path.exists());
    assert!(!resources.owns("candidate"));
    assert!(resources.retired("candidate"));
    bridge
        .shutdown(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn malformed_and_oversized_peer_frames_fail_health_and_release_owned_process() {
    for suffix in [
        "process.stdout.write('not JSON\\n');",
        "process.stdout.write('x'.repeat(70000)+'\\n');",
    ] {
        let (_directory, config) = fixture(&format!("{SCRIPT}\nsetTimeout(()=>{{{suffix}}},25);"));
        let bridge = Bridge::spawn(config).unwrap();
        thread::sleep(Duration::from_millis(70));
        assert!(bridge.check_health().is_err());
        bridge
            .shutdown(Instant::now() + Duration::from_secs(2))
            .unwrap();
    }
}
