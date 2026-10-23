//! Native filesystem notifications and reconciliation, without overriding timers.
use can_dev_server::{capture::CaptureRequest, watch::WatchSet};
use std::{
    fs,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
fn request(root: &Path) -> CaptureRequest {
    serde_json::from_value(serde_json::json!({"checkoutRoot":root,"appPath":"app/app.can","profile":"local-d1-identity","compilerPath":"tools/can","catalogPath":null,"helpIndexPath":"help.md","packageInputPaths":[],"extraInputPaths":[]})).unwrap()
}
fn reconcile_after_interval(watcher: &mut WatchSet) -> bool {
    thread::sleep(Duration::from_millis(2100));
    watcher.reconcile()
}
#[test]
fn ignores_parent_and_tool_siblings_but_observes_new_producer_members() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("project");
    for directory in ["app", "tools", "producer"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    fs::write(root.join("app/app.can"), "first").unwrap();
    fs::write(root.join("tools/can"), "compiler").unwrap();
    fs::write(root.join("producer/index.js"), "producer").unwrap();
    let mut input = request(&root);
    input
        .package_input_paths
        .push(can_dev_server::capture::NamedInputPath {
            name: "runtime".into(),
            path: "producer/index.js".into(),
        });
    let (tx, rx) = mpsc::channel();
    let mut watcher = WatchSet::new(move || {
        let _ = tx.send(());
    })
    .unwrap();
    watcher.set_inputs(&input, None).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    watcher.reconcile();
    while rx.try_recv().is_ok() {}
    fs::write(outer.path().join("unrelated"), "peer").unwrap();
    fs::create_dir(outer.path().join("sdk-spool")).unwrap();
    fs::write(root.join("tools/can-dev"), "another executable").unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert!(rx.try_recv().is_err());
    assert!(!reconcile_after_interval(&mut watcher));
    fs::write(root.join("producer/new.js"), "new member").unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(watcher.reconcile());
    while rx.try_recv().is_ok() {}
    fs::write(root.join("app/app.can"), "changed").unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(watcher.reconcile());
    watcher.close().unwrap();
}
#[test]
fn edits_replacement_missing_parent_recovery_and_close_are_only_hints() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("app")).unwrap();
    fs::write(root.path().join("app/app.can"), "first").unwrap();
    let (tx, rx) = mpsc::sync_channel(32);
    let count = Arc::new(AtomicUsize::new(0));
    let called = count.clone();
    let mut watcher = WatchSet::new(move || {
        called.fetch_add(1, Ordering::AcqRel);
        let _ = tx.try_send(());
    })
    .unwrap();
    let input = request(root.path());
    assert!(watcher.set_inputs(&input, None).unwrap() >= 2);
    fs::write(root.path().join("app/app.can"), "edit").unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(watcher.reconcile());
    fs::rename(root.path().join("app"), root.path().join("old")).unwrap();
    assert!(reconcile_after_interval(&mut watcher));
    fs::create_dir(root.path().join("app")).unwrap();
    fs::write(root.path().join("app/app.can"), "recovered").unwrap();
    assert!(reconcile_after_interval(&mut watcher));
    while rx.try_recv().is_ok() {}
    fs::write(root.path().join("app/app.can"), "after-recovery").unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(!watcher.audit_due());
    watcher.close().unwrap();
    let before = count.load(Ordering::Acquire);
    fs::write(root.path().join("app/app.can"), "after-close").unwrap();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(before, count.load(Ordering::Acquire));
    assert!(!watcher.reconcile());
    assert!(!watcher.audit_due());
    assert!(watcher.set_inputs(&input, None).is_err());
    watcher.close().unwrap();
}

#[test]
fn fallback_replacement_is_reconciled_before_missing_inputs_recover() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("outside")).unwrap();
    let mut input = request(root.path());
    input.app_path = "outside/missing/child/app.can".into();
    let (tx, rx) = mpsc::channel();
    let mut watcher = WatchSet::new(move || {
        let _ = tx.send(());
    })
    .unwrap();
    watcher.set_inputs(&input, None).unwrap();
    fs::rename(root.path().join("outside"), root.path().join("retired")).unwrap();
    fs::create_dir(root.path().join("outside")).unwrap();
    assert!(reconcile_after_interval(&mut watcher));
    fs::create_dir_all(root.path().join("outside/missing/child")).unwrap();
    assert!(reconcile_after_interval(&mut watcher));
    while rx.try_recv().is_ok() {}
    fs::write(root.path().join(&input.app_path), "recovered").unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(watcher.reconcile());
    watcher.close().unwrap();
}
#[test]
fn elapsed_audit_requests_verification_without_inventing_changes() {
    let mut watcher = WatchSet::new(|| {}).unwrap();
    assert!(!watcher.audit_due());
    thread::sleep(Duration::from_millis(30100));
    assert!(watcher.audit_due());
    assert!(!watcher.audit_due());
    assert!(!watcher.reconcile());
    watcher.close().unwrap();
    assert!(!watcher.audit_due());
}
