//! Actual claim boundary integration; assertions run through the public owning API.
use super::fixtures::{lookup, selection};
use can_dev_server::claim::*;
use serde_json::{Value, json};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, symlink};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};
#[test]
fn publishes_private_identity_and_refuses_live_unresponsive_owner() {
    let (_root, _runtime, selection) = selection();
    let mut claim = Claim::acquire(&selection).unwrap();
    assert!(claim.require_ownership().is_ok());
    let identity = discover(&lookup(&selection)).unwrap();
    assert_eq!(identity, claim.identity);
    assert_eq!(
        fs::metadata(&claim.descriptor_path().parent().unwrap().join("claim.json"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&Path::new(&claim.identity.socket_path))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    assert!(claim.identity.socket_path.len() <= 100);
    // No serving loop is running: PID/birth still prevent destructive
    // takeover while the control endpoint is temporarily unavailable.
    assert_eq!(
        Claim::acquire(&selection).err().unwrap().code,
        "OWNER_UNRESPONSIVE"
    );
    claim.retire().unwrap();
    assert!(!claim.descriptor_path().parent().unwrap().exists());
}

#[test]
fn inode_replacement_never_publishes_or_removes_foreign_claim() {
    let (_root, _runtime, selection) = selection();
    let mut claim = Claim::acquire(&selection).unwrap();
    let moved = claim
        .descriptor_path()
        .parent()
        .unwrap()
        .with_extension("old");
    fs::rename(&claim.descriptor_path().parent().unwrap(), &moved).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&claim.descriptor_path().parent().unwrap())
        .unwrap();
    fs::write(
        &claim.descriptor_path().parent().unwrap().join("claim.json"),
        b"foreign claim",
    )
    .unwrap();
    assert_eq!(claim.require_ownership().unwrap_err().code, "CLAIM_LOST");
    assert_eq!(claim.retire().unwrap_err().code, "CLAIM_LOST");
    assert_eq!(
        fs::read(&claim.descriptor_path().parent().unwrap().join("claim.json")).unwrap(),
        b"foreign claim"
    );
    assert!(!claim.descriptor_path().exists());
}

#[test]
fn changed_descriptor_refuses_release_and_retains_claim() {
    let (_root, _runtime, selection) = selection();
    let mut claim = Claim::acquire(&selection).unwrap();
    let mut foreign = claim.identity.clone();
    foreign.session_id = "foreign".into();
    fs::write(
        &claim.descriptor_path(),
        serde_json::to_vec(&foreign).unwrap(),
    )
    .unwrap();
    assert_eq!(claim.retire().unwrap_err().code, "CLAIM_LOST");
    assert!(claim.require_ownership().is_ok());
    assert!(claim.listener().is_some());
    fs::write(
        &claim.descriptor_path(),
        serde_json::to_vec(&claim.identity).unwrap(),
    )
    .unwrap();
    claim.retire().unwrap();
}

#[test]
fn rejects_unsafe_runtime_dirs_and_checkout_local_control_state() {
    let (root, runtime, mut selection) = selection();
    fs::set_permissions(runtime.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        Claim::acquire(&selection).err().unwrap().code,
        "INSECURE_RUNTIME_DIR"
    );
    fs::set_permissions(runtime.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let link = root.path().join("runtime-link");
    symlink(runtime.path(), &link).unwrap();
    selection.runtime_dir = Some(link);
    assert_eq!(
        Claim::acquire(&selection).err().unwrap().code,
        "INSECURE_RUNTIME_DIR"
    );
    selection.runtime_dir = Some(root.path().join("runtime"));
    assert_eq!(
        Claim::acquire(&selection).err().unwrap().code,
        "INVALID_RUNTIME_DIR"
    );
}

#[test]
fn interrupted_publication_waits_for_grace_and_dead_or_reused_pid_can_be_reclaimed() {
    for stale_pid in [false, true] {
        let (_root, _runtime, selection) = selection();
        let mut original = Claim::acquire(&selection).unwrap();
        let directory = original.descriptor_path().parent().unwrap().to_path_buf();
        let mut stored: Value =
            serde_json::from_slice(&fs::read(directory.join("claim.json")).unwrap()).unwrap();
        original.retire().unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        assert_eq!(
            Claim::acquire(&selection).err().unwrap().code,
            "CLAIM_IN_PROGRESS"
        );
        if stale_pid {
            stored["pid"] = json!(i32::MAX);
        } else {
            let birth = stored["processBirth"]
                .as_str()
                .expect("Linux process birth identity")
                .to_owned();
            stored["processBirth"] = json!(format!("{birth}-old"));
        }
        fs::write(
            directory.join("claim.json"),
            serde_json::to_vec(&stored).unwrap(),
        )
        .unwrap();
        fs::set_permissions(
            directory.join("claim.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let mut replacement = Claim::acquire(&selection).unwrap();
        assert_ne!(
            replacement.identity.session_id,
            stored["sessionId"].as_str().unwrap()
        );
        replacement.require_ownership().unwrap();
        replacement.retire().unwrap();
    }
    let (_root, _runtime, selection) = selection();
    let mut original = Claim::acquire(&selection).unwrap();
    let directory = original.descriptor_path().parent().unwrap().to_path_buf();
    original.retire().unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    fs::File::open(&directory)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(11)))
        .unwrap();
    let mut replacement = Claim::acquire(&selection).unwrap();
    replacement.retire().unwrap();
}
