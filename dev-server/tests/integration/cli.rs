//! Shipping CLI process -> parsing/envelope -> verified private control socket.
use can_dev_server::{
    claim::{Lookup, Selection},
    control::Server,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
    sync::{Arc, Mutex},
};
fn invoke(args: &[&str], directory: &std::path::Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_can-dev"))
        .args(args)
        .env("TMPDIR", directory)
        .current_dir(directory)
        .output()
        .unwrap()
}
#[test]
fn nonstarting_help_and_usage_errors_do_not_claim_an_owner() {
    let directory = tempfile::tempdir().unwrap();
    for args in [vec![], vec!["help"], vec!["--help"], vec!["-h"]] {
        let output = invoke(&args, directory.path());
        assert!(output.status.success());
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["result"]["schema"], "can.dev.control-help.v1");
        assert_eq!(
            output
                .stdout
                .split(|b| *b == b'\n')
                .filter(|s| !s.is_empty())
                .count(),
            1
        );
    }
    assert!(
        String::from_utf8(invoke(&["--version"], directory.path()).stdout)
            .unwrap()
            .contains("can.dev.control.v1")
    );
    for (args, code) in [
        (vec!["--version", "status"], "INVALID_ARGUMENTS"),
        (vec!["unknown"], "UNKNOWN_COMMAND"),
        (vec!["status", "--revision", "r1"], "INVALID_ARGUMENTS"),
        (vec!["status", "--root"], "INVALID_ARGUMENTS"),
        (
            vec!["check", "--root", "a", "--root", "b"],
            "INVALID_ARGUMENTS",
        ),
        (vec!["check", "extra"], "INVALID_ARGUMENTS"),
        (
            vec!["check", "--expected-revision", "r0"],
            "INVALID_REVISION",
        ),
        (vec!["diagnostics"], "REVISION_REQUIRED"),
        (
            vec!["diagnostics", "--revision", "r1", "--limit", "26"],
            "INVALID_ARGUMENTS",
        ),
        (
            vec!["diagnostic.detail", "--revision", "r1", "--index", "01"],
            "INVALID_ARGUMENTS",
        ),
        (
            vec!["construct.help", "--revision", "r1"],
            "CONSTRUCT_ID_REQUIRED",
        ),
        (
            vec!["rank.lookup", "--revision", "r1", "--ref", "bad"],
            "RANK_REF_REQUIRED",
        ),
        (
            vec![
                "construct.rank",
                "--revision",
                "r1",
                "--index",
                "0",
                "--author-intent",
                "bad\nintent",
            ],
            "INVALID_ARGUMENTS",
        ),
        (vec!["start"], "INVALID_ARGUMENTS"),
        (
            vec!["start", "--source", "a", "--capture", "b"],
            "INVALID_ARGUMENTS",
        ),
        (
            vec![
                "start",
                "--source",
                "a",
                "--preview-roles",
                r#"{"Ava":["admin","admin"]}"#,
            ],
            "INVALID_ARGUMENTS",
        ),
    ] {
        let output = invoke(&args, directory.path());
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["code"], code, "{args:?}: {value}");
    }
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}
#[test]
fn cli_selected_session_routes_revision_and_example_payloads_over_real_control() {
    let directory = tempfile::tempdir_in("/tmp").unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    let runtime = directory
        .path()
        .join(format!("cv-{}", unsafe { libc::getuid() }));
    fs::create_dir(&runtime).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let selection = Selection {
        checkout_root: root.to_str().unwrap().into(),
        app: "Office".into(),
        profile: "local".into(),
        runtime_dir: Some(runtime.clone()),
    };
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let mut server = Server::start(
        selection,
        Arc::new(move |command| {
            recorded.lock().unwrap().push(command.clone());
            Ok(json!({"received":command.command,"payload":command.payload}))
        }),
    )
    .unwrap();
    let root_text = root.to_str().unwrap();
    let id = &server.identity.session_id;
    for (args, expected) in [
        (
            vec![
                "diagnostics",
                "--revision",
                "r12",
                "--after",
                "-1",
                "--limit",
                "25",
            ],
            json!({"revision":"r12","after":-1,"limit":25}),
        ),
        (
            vec![
                "example.run",
                "--expected-revision",
                "r2",
                "--operation",
                "App.save",
                "--row",
                "0",
            ],
            json!({"expectedRevision":"r2","operation":"App.save","rowIndex":0}),
        ),
        (
            vec![
                "construct.help",
                "--revision",
                "r1",
                "--id",
                "can.v1.ui.table",
            ],
            json!({"revision":"r1","id":"can.v1.ui.table"}),
        ),
    ] {
        let mut argv = args.clone();
        argv.extend(["--root", root_text, "--session", id]);
        let output = invoke(&argv, directory.path());
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["session"], *id);
        assert_eq!(value["result"]["payload"], expected);
    }
    let discovered = can_dev_server::claim::discover(&Lookup {
        checkout_root: root_text.into(),
        runtime_dir: Some(runtime),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(discovered.session_id, *id);
    assert_eq!(requests.lock().unwrap().len(), 3);
    server.stop().unwrap();
}
