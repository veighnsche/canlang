//! Filesystem source membership is authoritative, including alias and freshness refusal.
use can_dev_server::inventory::compiler_inputs;
use std::{
    fs,
    os::unix::fs::symlink,
    sync::atomic::AtomicBool,
    time::{Duration, SystemTime},
};
#[test]
fn compiler_inventory_refreshes_membership_refuses_aliases_and_stale_or_foreign_binaries() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("compiler/src")).unwrap();
    fs::create_dir_all(root.path().join("compiler/target/debug")).unwrap();
    for path in [
        "compiler/src/main.rs",
        "compiler/Cargo.toml",
        "compiler/Cargo.lock",
        "compiler/target/debug/can",
    ] {
        fs::write(root.path().join(path), "fixture").unwrap();
    }
    let binary = root.path().join("compiler/target/debug/can");
    let future = SystemTime::now() + Duration::from_secs(5);
    fs::File::open(&binary)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(future))
        .unwrap();
    let cancel = AtomicBool::new(false);
    let first = compiler_inputs(root.path(), &binary, &cancel).unwrap();
    assert_eq!(first.len(), 3);
    fs::write(root.path().join("compiler/src/added.rs"), "new membership").unwrap();
    let second = compiler_inputs(root.path(), &binary, &cancel).unwrap();
    assert_eq!(second.len(), 4);
    assert!(second.iter().any(|p| p.ends_with("added.rs")));
    symlink(
        root.path().join("compiler/src/main.rs"),
        root.path().join("compiler/src/alias.rs"),
    )
    .unwrap();
    assert!(compiler_inputs(root.path(), &binary, &cancel).is_err());
    fs::remove_file(root.path().join("compiler/src/alias.rs")).unwrap();
    fs::File::open(root.path().join("compiler/src/main.rs"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(future + Duration::from_secs(1)))
        .unwrap();
    assert!(
        compiler_inputs(root.path(), &binary, &cancel)
            .unwrap_err()
            .contains("older than source")
    );
    let foreign = root.path().join("foreign");
    fs::write(&foreign, "unowned compiler").unwrap();
    assert!(
        compiler_inputs(root.path(), &foreign, &cancel)
            .unwrap_err()
            .contains("selected checkout target")
    );
    assert!(compiler_inputs(root.path(), &binary, &AtomicBool::new(true)).is_err());
}
