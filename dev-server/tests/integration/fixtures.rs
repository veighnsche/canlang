use can_dev_server::{
    capture::*,
    claim::{Lookup, Selection},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};
pub(crate) fn fixture() -> (tempfile::TempDir, CaptureRequest) {
    let root = tempfile::tempdir().unwrap();
    for (path, bytes) in [
        ("app.can", "app Office\r\nGiven\r\nWhen\r\nThen\r\n"),
        ("compiler", "compiler A"),
        ("catalog.json", "catalog A"),
        ("help.json", "help A"),
        ("runtime.js", "runtime A"),
    ] {
        fs::write(root.path().join(path), bytes).unwrap();
    }
    let request = CaptureRequest {
        checkout_root: root.path().to_str().unwrap().to_owned(),
        app_path: "app.can".into(),
        profile: "first".into(),
        compiler_path: "compiler".into(),
        catalog_path: Some("catalog.json".into()),
        help_index_path: "help.json".into(),
        package_input_paths: vec![NamedInputPath {
            name: "runtime".into(),
            path: "runtime.js".into(),
        }],
        extra_input_paths: Vec::new(),
        semantic_options: BTreeMap::from([("mode".into(), "local".into())]),
        input_inventory: None,
    };
    (root, request)
}
pub(crate) fn empty_inventory() -> Result<Inventory> {
    Ok(Inventory::default())
}
pub(crate) fn selection() -> (tempfile::TempDir, tempfile::TempDir, Selection) {
    let root = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = tempfile::tempdir_in("/tmp").unwrap();
    fs::set_permissions(runtime.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let selection = Selection {
        checkout_root: root.path().to_str().unwrap().to_owned(),
        app: "app.can".into(),
        profile: "local".into(),
        runtime_dir: Some(runtime.path().to_path_buf()),
    };
    (root, runtime, selection)
}
pub(crate) fn lookup(selection: &Selection) -> Lookup {
    Lookup {
        checkout_root: selection.checkout_root.clone(),
        runtime_dir: selection.runtime_dir.clone(),
        ..Lookup::default()
    }
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
