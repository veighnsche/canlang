//! Actual capture boundary integration; assertions run through the public owning API.
use super::fixtures::{empty_inventory, fixture, hash};
use can_dev_server::capture::*;
use std::cell::Cell;
use std::os::unix::fs::symlink;
use std::{fs, sync::atomic::AtomicBool};
fn closure_fixture(app: &str, files: &[(&str, &str)]) -> (tempfile::TempDir, CaptureRequest) {
    let (root, mut request) = fixture();
    fs::create_dir_all(root.path().join("draft/apps/Demo")).unwrap();
    fs::create_dir_all(root.path().join("draft/shared")).unwrap();
    fs::write(root.path().join("draft/apps/Demo/app.can"), app).unwrap();
    for (path, bytes) in files {
        fs::write(root.path().join(path), bytes).unwrap();
    }
    request.app_path = "draft/apps/Demo/app.can".into();
    (root, request)
}
fn no_cancel() -> AtomicBool {
    AtomicBool::new(false)
}
#[test]
fn provider_closure_captures_transitive_providers() {
    let (root, request) = closure_fixture(
        "app First\nuse Mid {A}\n",
        &[
            ("draft/shared/mid.can", "package Mid\nuse Leaf {B}\n"),
            ("draft/shared/leaf.can", "package Leaf\n"),
        ],
    );
    let captured = capture(&request, &empty_inventory, &no_cancel()).unwrap();
    let providers = captured.provider_snapshot.as_ref().unwrap();
    let names: Vec<_> = providers.iter().map(|p| p.package.as_str()).collect();
    assert_eq!(names, ["Leaf", "Mid"]);
    for provider in providers {
        assert_eq!(provider.snapshot.bytes.kind, "Buffer");
        let read = fs::read(root.path().join(&provider.snapshot.path)).unwrap();
        assert_eq!(hash(&read), provider.snapshot.sha256);
    }
}

#[test]
fn provider_closure_refuses_missing_and_ambiguous() {
    let (_root, request) = closure_fixture("app First\nuse Ghost {A}\n", &[]);
    let reason = capture(&request, &empty_inventory, &no_cancel()).unwrap_err();
    assert!(reason.contains("no provider source"), "{reason}");
    let (root, request) = closure_fixture(
        "app First\nuse Dup {A}\n",
        &[
            ("draft/apps/Demo/dup-a.can", "package Dup\n"),
            ("draft/shared/dup-b.can", "package Dup\n"),
        ],
    );
    let reason = capture(&request, &empty_inventory, &no_cancel()).unwrap_err();
    assert!(reason.contains("ambiguous"), "{reason}");
    let _ = root;
}

#[test]
fn exact_bytes_separate_source_and_producer_epochs() {
    let (root, request) = fixture();
    let first = capture(&request, &empty_inventory, &no_cancel()).unwrap();
    assert!(first.source_text.contains("\r\n"));
    assert!(is_current(&first, &empty_inventory, &no_cancel()));
    fs::write(root.path().join("catalog.json"), "catalog B").unwrap();
    let second = capture(&request, &empty_inventory, &no_cancel()).unwrap();
    assert_eq!(first.source_revision, second.source_revision);
    assert_ne!(first.epoch_material, second.epoch_material);
    assert!(!producer_inputs_current(
        &first,
        &empty_inventory,
        &no_cancel()
    ));
    assert!(runtime_inputs_current(
        &first,
        &empty_inventory,
        &no_cancel()
    ));
    fs::write(root.path().join("app.can"), "app Edited\n").unwrap();
    assert!(!is_current(&second, &empty_inventory, &no_cancel()));
    assert!(producer_inputs_current(
        &second,
        &empty_inventory,
        &no_cancel()
    ));
    assert!(runtime_inputs_current(
        &second,
        &empty_inventory,
        &no_cancel()
    ));
}

#[test]
fn rejects_invalid_utf8_and_source_escape() {
    let (root, request) = fixture();
    fs::write(root.path().join("app.can"), [0xff]).unwrap();
    assert!(
        capture(&request, &empty_inventory, &no_cancel())
            .unwrap_err()
            .contains("UTF-8")
    );
    let other = tempfile::tempdir().unwrap();
    fs::write(other.path().join("outside.can"), "app Outside").unwrap();
    fs::remove_file(root.path().join("app.can")).unwrap();
    symlink(
        other.path().join("outside.can"),
        root.path().join("app.can"),
    )
    .unwrap();
    assert!(
        capture(&request, &empty_inventory, &no_cancel())
            .unwrap_err()
            .contains("escapes")
    );
}

#[test]
fn refuses_alias_retarget_even_when_bytes_match() {
    let (root, mut request) = fixture();
    fs::write(root.path().join("runtime-b.js"), "runtime A").unwrap();
    symlink("runtime.js", root.path().join("alias.js")).unwrap();
    request.package_input_paths[0].path = "alias.js".into();
    let captured = capture(&request, &empty_inventory, &no_cancel()).unwrap();
    fs::remove_file(root.path().join("alias.js")).unwrap();
    symlink("runtime-b.js", root.path().join("alias.js")).unwrap();
    assert!(!runtime_inputs_current(
        &captured,
        &empty_inventory,
        &no_cancel()
    ));
}

#[test]
fn installed_membership_and_final_capture_bytes_are_authoritative() {
    let (root, mut request) = fixture();
    request.input_inventory = Some("installed-local-preview".into());
    let inventory = Inventory {
        package_input_paths: request.package_input_paths.clone(),
        extra_input_paths: Vec::new(),
    };
    let first = capture(&request, &|| Ok(inventory.clone()), &no_cancel()).unwrap();
    let mut added = inventory.clone();
    added.package_input_paths.push(NamedInputPath {
        name: "new".into(),
        path: "new.js".into(),
    });
    assert!(!is_current(&first, &|| Ok(added.clone()), &no_cancel()));
    assert!(!is_current(&first, &empty_inventory, &no_cancel()));
    let calls = Cell::new(0);
    let changed = || {
        calls.set(calls.get() + 1);
        if calls.get() == 2 {
            fs::write(root.path().join("app.can"), "app Changed\n").unwrap();
        }
        Ok(inventory.clone())
    };
    assert!(
        capture(&request, &changed, &no_cancel())
            .unwrap_err()
            .contains("source changed")
    );
}

#[test]
fn rejects_missing_producers_duplicates_and_cancelled_work() {
    let (root, mut request) = fixture();
    request.extra_input_paths = vec![
        NamedInputPath {
            name: "x".into(),
            path: "help.json".into(),
        },
        NamedInputPath {
            name: "x".into(),
            path: "help.json".into(),
        },
    ];
    assert!(capture(&request, &empty_inventory, &no_cancel()).is_err());
    request.extra_input_paths.clear();
    fs::remove_file(root.path().join("runtime.js")).unwrap();
    assert!(capture(&request, &empty_inventory, &no_cancel()).is_err());
    assert_eq!(
        capture(&request, &empty_inventory, &AtomicBool::new(true)).unwrap_err(),
        "cancelled"
    );
    request.catalog_path = None;
    fs::write(root.path().join("runtime.js"), "runtime A").unwrap();
    let captured = capture(&request, &empty_inventory, &no_cancel()).unwrap();
    assert_eq!(
        captured
            .inputs
            .iter()
            .find(|i| i.name == "catalog")
            .unwrap()
            .state,
        "missing"
    );
}

#[test]
fn generated_runtime_currency_uses_current_status_without_pinning_analysis_compiler() {
    let (root, mut request) = fixture();
    fs::write(root.path().join("app.can"), "app Office\n## $Saved\n").unwrap();
    let generated = "can.generated/unit/member.can";
    fs::create_dir_all(root.path().join("can.generated/unit")).unwrap();
    fs::write(root.path().join(generated), "package Saved\n").unwrap();
    let source_hash = hash(&fs::read(root.path().join("app.can")).unwrap());
    let generated_hash = hash(&fs::read(root.path().join(generated)).unwrap());
    let report = serde_json::json!({"ok":true,"units":[{"id":"unit","association":"current",
        "current_files":[{"path":"app.can","sha256":source_hash},{"path":generated,"sha256":generated_hash}],
        "compiler_sources":["app.can",generated]}]});
    let compiler = format!(
        "#!/bin/sh\ntest \"$1\" = gen || exit 7\ntest \"$CAN_GENERATION_COMPILER_ONLY\" = 1 || exit 7\nprintf '%s' '{}'\n",
        report
    );
    fs::write(root.path().join("compiler"), &compiler).unwrap();
    request.input_inventory = Some("installed-local-preview".into());
    let inventory = Inventory {
        package_input_paths: request.package_input_paths.clone(),
        extra_input_paths: Vec::new(),
    };
    let locks = root.path().join(".can/gen/locks");
    fs::create_dir_all(&locks).unwrap();
    fs::write(locks.join("app.can.write.lock"), "held by compiler").unwrap();
    assert!(
        capture(&request, &|| Ok(inventory.clone()), &no_cancel())
            .unwrap_err()
            .contains("writer")
    );
    fs::remove_file(locks.join("app.can.write.lock")).unwrap();
    let journal = root.path().join(".can/gen/runs/interrupted/journal.json");
    fs::create_dir_all(journal.parent().unwrap()).unwrap();
    fs::write(&journal, "{}").unwrap();
    assert!(
        capture(&request, &|| Ok(inventory.clone()), &no_cancel())
            .unwrap_err()
            .contains("unresolved")
    );
    assert_eq!(fs::read_dir(&locks).unwrap().count(), 0);
    fs::remove_file(journal).unwrap();
    let captured = capture(&request, &|| Ok(inventory.clone()), &no_cancel()).unwrap();
    assert_eq!(captured.generated_closure.as_ref().unwrap().files.len(), 1);
    assert_eq!(captured.source_snapshot.as_ref().unwrap().len(), 2);
    fs::write(
        root.path().join("compiler"),
        format!("{compiler}## compiler build B\n"),
    )
    .unwrap();
    assert!(!producer_inputs_current(
        &captured,
        &|| Ok(inventory.clone()),
        &no_cancel()
    ));
    assert!(runtime_inputs_current(
        &captured,
        &|| Ok(inventory.clone()),
        &no_cancel()
    ));
    fs::write(root.path().join(generated), "package Changed\n").unwrap();
    assert!(!runtime_inputs_current(
        &captured,
        &|| Ok(inventory.clone()),
        &no_cancel()
    ));
}

#[test]
fn provider_generations_union_into_staged_closure() {
    let (root, mut request) = fixture();
    let app_dir = root.path().join("draft/apps/Demo");
    let prov_dir = root.path().join("draft/shared");
    fs::create_dir_all(app_dir.join("can.generated/u1")).unwrap();
    fs::create_dir_all(prov_dir.join("can.generated/u2")).unwrap();
    fs::write(
        app_dir.join("app.can"),
        "app Demo\nuse Prov {X}\n## $\"app prompt\"\n",
    )
    .unwrap();
    fs::write(
        prov_dir.join("prov.can"),
        "package Prov\n## $\"prov prompt\"\n",
    )
    .unwrap();
    fs::write(app_dir.join("can.generated/u1/unit.json"), "{}").unwrap();
    fs::write(
        app_dir.join("can.generated/u1/style.css"),
        ":host { color: red; }",
    )
    .unwrap();
    fs::write(prov_dir.join("can.generated/u2/unit.json"), "{}").unwrap();
    fs::write(
        prov_dir.join("can.generated/u2/style.css"),
        ":host { color: blue; }",
    )
    .unwrap();
    fs::write(
        prov_dir.join("can.generated/u2/contributions.can"),
        "package Prov\n",
    )
    .unwrap();
    let app_hash = hash(&fs::read(app_dir.join("app.can")).unwrap());
    let app_unit = hash(&fs::read(app_dir.join("can.generated/u1/unit.json")).unwrap());
    let app_css = hash(&fs::read(app_dir.join("can.generated/u1/style.css")).unwrap());
    let prov_hash = hash(&fs::read(prov_dir.join("prov.can")).unwrap());
    let prov_unit = hash(&fs::read(prov_dir.join("can.generated/u2/unit.json")).unwrap());
    let prov_css = hash(&fs::read(prov_dir.join("can.generated/u2/style.css")).unwrap());
    let prov_carrier =
        hash(&fs::read(prov_dir.join("can.generated/u2/contributions.can")).unwrap());
    let app_report = serde_json::json!({"ok":true,"units":[{
        "id":"u1","association":"current",
        "current_files":[
            {"path":"app.can","sha256":app_hash},
            {"path":"can.generated/u1/unit.json","sha256":app_unit},
            {"path":"can.generated/u1/style.css","sha256":app_css}],
        "compiler_sources":["app.can"]}]});
    let prov_report = serde_json::json!({"ok":true,"units":[{
        "id":"u2","association":"current",
        "current_files":[
            {"path":"prov.can","sha256":prov_hash},
            {"path":"can.generated/u2/unit.json","sha256":prov_unit},
            {"path":"can.generated/u2/style.css","sha256":prov_css},
            {"path":"can.generated/u2/contributions.can","sha256":prov_carrier}],
        "compiler_sources":["prov.can","can.generated/u2/contributions.can"]}]});
    let compiler = format!(
        "#!/bin/sh\ntest \"$1\" = gen || exit 7\ntest \"$CAN_GENERATION_COMPILER_ONLY\" = 1 || exit 7\nreq=$(cat)\ncase \"$req\" in\n*apps/Demo*) printf '%s' '{app_report}' ;;\n*) printf '%s' '{prov_report}' ;;\nesac\n"
    );
    fs::write(root.path().join("compiler"), &compiler).unwrap();
    request.app_path = "draft/apps/Demo/app.can".into();
    request.input_inventory = Some("installed-local-preview".into());
    let inventory = Inventory {
        package_input_paths: request.package_input_paths.clone(),
        extra_input_paths: Vec::new(),
    };
    let captured = capture(&request, &|| Ok(inventory.clone()), &no_cancel()).unwrap();
    let closure = captured.generated_closure.as_ref().unwrap();
    let staged: Vec<_> = closure.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        staged.contains(&"draft/apps/Demo/can.generated/u1/style.css"),
        "{staged:?}"
    );
    assert!(
        staged.contains(&"draft/shared/can.generated/u2/style.css"),
        "{staged:?}"
    );
    assert!(
        staged.contains(&"draft/shared/can.generated/u2/contributions.can"),
        "{staged:?}"
    );
    assert_eq!(closure.provider_sources.len(), 1);
    assert_eq!(
        closure.provider_sources[0].key,
        "can.generated/u2/contributions.can"
    );
    assert_eq!(
        closure.provider_sources[0].physical,
        "draft/shared/can.generated/u2/contributions.can"
    );
    let snapshot = captured.source_snapshot.as_ref().unwrap();
    assert!(snapshot.iter().any(
        |s| s.path == "draft/shared/can.generated/u2/contributions.can" && s.sha256 == prov_carrier
    ));
    // Membership: operand + provider + the synthetic carrier source.
    let report = serde_json::json!({"sources": [
        {"path": "draft/apps/Demo/app.can", "sha256": app_hash},
        {"path": "draft/shared/prov.can", "sha256": prov_hash},
        {"path": "can.generated/u2/contributions.can", "sha256": prov_carrier},
    ]});
    verify_compiler_sources(&captured, &report, true).unwrap();
    // Multi-root compiles qualify carriers (`r<root>-`); membership
    // normalizes the qualifier and still anchors bytes.
    let qualified = serde_json::json!({"sources": [
        {"path": "draft/apps/Demo/app.can", "sha256": app_hash},
        {"path": "draft/shared/prov.can", "sha256": prov_hash},
        {"path": "can.generated/r1-u2/contributions.can", "sha256": prov_carrier},
    ]});
    verify_compiler_sources(&captured, &qualified, true).unwrap();
}
