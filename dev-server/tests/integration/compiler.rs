//! Actual compiler boundary integration; assertions run through the public owning API.
use super::fixtures::{empty_inventory, fixture, hash};
use can_dev_server::capture;
use can_dev_server::compiler::*;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
fn script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn artifact(hash: &str) -> Value {
    serde_json::json!({"artifact_version":1,"tool_version":"test","language_version":"test",
        "sources":[{"path":"app.can","sha256":hash}],"modules":[{"path":"app.js","js":"export {}","map":{"version":3}}],"callables":[],"requires":[{"capability":"canlang.builtins","min_version":0}]})
}
fn compiler_output(root: &Path, output: &Value, code: i32) {
    let encoded = output.to_string().replace('\'', "'\"'\"'");
    script(
        &root.join("compiler"),
        &format!("printf '%s' '{encoded}'\nexit {code}"),
    );
}
#[test]
fn accepts_only_source_bound_artifact_and_exit_ten_diagnostics() {
    let (root, request) = fixture();
    let hash = hash(&fs::read(root.path().join("app.can")).unwrap());
    compiler_output(root.path(), &artifact(&hash), 0);
    let cancel = AtomicBool::new(false);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    let phases = std::cell::RefCell::new(Vec::new());
    let result = compile(&captured, &empty_inventory, &cancel, &|p| {
        phases.borrow_mut().push(p.to_string())
    });
    assert!(
        matches!(result, CompileResult::Artifact { .. }),
        "{result:?}"
    );
    assert_eq!(
        *phases.borrow(),
        [
            "staging_compiler",
            "compiler",
            "verifying_compiler_inputs",
            "verifying_inventory",
            "verifying_producer_bytes",
            "verifying_source_bytes",
            "verifying_provider_bytes"
        ]
    );
    let diagnostic = serde_json::json!({"complete":true,"sources":[{"path":"app.can","sha256":hash}],"diagnostics":[{"code":"E2005"}]});
    compiler_output(root.path(), &diagnostic, 10);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    assert!(matches!(
        compile(&captured, &empty_inventory, &cancel, &|_| {}),
        CompileResult::Diagnostics { .. }
    ));
    compiler_output(root.path(), &artifact("wrong"), 0);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    let result = compile(&captured, &empty_inventory, &cancel, &|_| {});
    assert!(
        matches!(result, CompileResult::CaptureIncomplete { ref reason } if reason.contains("source_hash_mismatch")),
        "{result:?}"
    );
}

#[test]
fn stages_exact_source_and_compiler_flags_then_refuses_mutated_catalog() {
    let (root, request) = fixture();
    let hash = hash(&fs::read(root.path().join("app.can")).unwrap());
    let encoded = artifact(&hash).to_string();
    script(
        &root.path().join("compiler"),
        &format!(
            "test \"$1\" = compile || exit 8\ntest \"$2\" = --format=json || exit 8\ntest \"$3\" = --native-scenario-receipts || exit 8\ntest \"$(cat app.can)\" = 'app Office\r\nGiven\r\nWhen\r\nThen\r' || exit 8\ntest \"$(cat \"$CAN_CATALOG\")\" = 'catalog A' || exit 8\nprintf '%s' '{encoded}'"
        ),
    );
    let cancel = AtomicBool::new(false);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    let result = compile(&captured, &empty_inventory, &cancel, &|_| {});
    assert!(
        matches!(result, CompileResult::Artifact { .. }),
        "{result:?}"
    );
    fs::write(root.path().join("catalog.json"), "changed").unwrap();
    let result = compile(&captured, &empty_inventory, &cancel, &|_| {});
    assert!(
        matches!(result, CompileResult::CaptureIncomplete {reason} if reason.contains("catalog changed"))
    );
}

#[test]
fn compiles_composed_closure_with_provider_operands() {
    let (root, mut request) = fixture();
    fs::create_dir_all(root.path().join("draft/apps/Demo")).unwrap();
    fs::create_dir_all(root.path().join("draft/shared")).unwrap();
    fs::write(
        root.path().join("draft/apps/Demo/app.can"),
        "app First\nuse Prov {Thing}\npackage Mine\n",
    )
    .unwrap();
    fs::write(root.path().join("draft/shared/prov.can"), "package Prov\n").unwrap();
    request.app_path = "draft/apps/Demo/app.can".into();
    let app_hash = hash(&fs::read(root.path().join("draft/apps/Demo/app.can")).unwrap());
    let prov_hash = hash(&fs::read(root.path().join("draft/shared/prov.can")).unwrap());
    let encoded = serde_json::json!({"artifact_version":1,"tool_version":"test","language_version":"test",
        "sources":[{"path":"draft/apps/Demo/app.can","sha256":app_hash},{"path":"draft/shared/prov.can","sha256":prov_hash}],
        "modules":[{"path":"app.js","js":"export {}","map":{"version":3}}],"callables":[],
        "requires":[{"capability":"canlang.builtins","min_version":0}]})
    .to_string();
    script(
        &root.path().join("compiler"),
        &format!(
            "test \"$5\" = draft/apps/Demo/app.can || exit 8\ntest \"$6\" = draft/shared/prov.can || exit 8\ntest \"$(cat draft/shared/prov.can)\" = 'package Prov' || exit 8\nprintf '%s' '{encoded}'"
        ),
    );
    let cancel = AtomicBool::new(false);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    let providers = captured.provider_snapshot.as_ref().unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].package, "Prov");
    assert_eq!(providers[0].snapshot.path, "draft/shared/prov.can");
    assert_eq!(providers[0].snapshot.sha256, prov_hash);
    let result = compile(&captured, &empty_inventory, &cancel, &|_| {});
    assert!(
        matches!(result, CompileResult::Artifact { .. }),
        "{result:?}"
    );
    // A provider edit invalidates the captured closure.
    fs::write(
        root.path().join("draft/shared/prov.can"),
        "package Prov\n// changed\n",
    )
    .unwrap();
    assert!(!capture::is_current(&captured, &empty_inventory, &cancel));
    // Corrupt snapshot bytes refuse before the compiler runs.
    let mut tampered = captured.clone();
    let snapshot = tampered.provider_snapshot.as_mut().unwrap();
    snapshot[0].snapshot.bytes.data = b"tampered".to_vec();
    assert!(
        matches!(compile(&tampered, &empty_inventory, &cancel, &|_| {}),
            CompileResult::CaptureIncomplete {reason} if reason.contains("provider snapshot hash mismatch"))
    );
    // An import with no provider refuses at capture without compiling.
    fs::write(
        root.path().join("draft/apps/Demo/app.can"),
        "app First\nuse Ghost {Thing}\n",
    )
    .unwrap();
    let reason = capture::capture(&request, &empty_inventory, &cancel).unwrap_err();
    assert!(reason.contains("no provider source"), "{reason}");
}

#[test]
fn refuses_result_when_source_changes_during_execution() {
    let (root, request) = fixture();
    let hash = hash(&fs::read(root.path().join("app.can")).unwrap());
    compiler_output(root.path(), &artifact(&hash), 0);
    let cancel = AtomicBool::new(false);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    let result = compile(&captured, &empty_inventory, &cancel, &|phase| {
        if phase == "compiler" {
            fs::write(root.path().join("app.can"), "app Changed\n").unwrap();
        }
    });
    assert!(
        matches!(result, CompileResult::CaptureIncomplete {reason} if reason.contains("inputs changed"))
    );
}

#[test]
fn cancellation_reaps_term_resistant_owned_compiler_and_its_pipes() {
    let (root, request) = fixture();
    script(
        &root.path().join("compiler"),
        "trap '' TERM\nwhile :; do sleep 1; done",
    );
    let cancel = AtomicBool::new(false);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    let start = Instant::now();
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(80));
            cancel.store(true, Ordering::Release);
        });
        assert!(matches!(
            compile(&captured, &empty_inventory, &cancel, &|_| {}),
            CompileResult::Cancelled { .. }
        ));
    });
    assert!(start.elapsed() < Duration::from_secs(3));
}
#[test]
fn malformed_exit_contracts_and_excessive_compiler_output_are_bounded() {
    let (root, request) = fixture();
    let cancel = AtomicBool::new(false);
    for (output, code) in [(json!([]), 10), (json!({}), 1)] {
        compiler_output(root.path(), &output, code);
        let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
        assert!(matches!(
            compile(&captured, &empty_inventory, &cancel, &|_| {}),
            CompileResult::ToolFailure { .. }
        ));
    }
    for redirection in ["", ">&2"] {
        script(
            &root.path().join("compiler"),
            &format!("head -c 17000000 /dev/zero {redirection}"),
        );
        let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
        let result = compile(&captured, &empty_inventory, &cancel, &|_| {});
        assert!(
            matches!(result,CompileResult::ToolFailure{ref reason} if reason.contains("exceeded limit")),
            "{result:?}"
        );
    }
    let mut invalid = artifact(&hash(&fs::read(root.path().join("app.can")).unwrap()));
    invalid["artifact_version"] = json!(999);
    compiler_output(root.path(), &invalid, 0);
    let captured = capture::capture(&request, &empty_inventory, &cancel).unwrap();
    assert!(matches!(
        compile(&captured, &empty_inventory, &cancel, &|_| {}),
        CompileResult::ToolFailure { .. }
    ));
}
