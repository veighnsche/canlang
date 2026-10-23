//! Actual files boundary integration; assertions run through the public owning API.
use can_dev_server::files::*;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{fs, path::Path};
#[test]
fn refs_bind_actual_private_bytes_and_reject_symlinks_or_permissions() {
    let mut files = Payloads::new().unwrap();
    let reference = files.write(b"one").unwrap();
    assert_eq!(read(&reference).unwrap(), b"one");
    fs::write(&reference.path, b"two").unwrap();
    assert!(read(&reference).is_err());
    fs::write(&reference.path, b"one").unwrap();
    fs::set_permissions(&reference.path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read(&reference).is_err());
    fs::set_permissions(&reference.path, fs::Permissions::from_mode(0o600)).unwrap();
    let alias = Path::new(&reference.path).parent().unwrap().join("alias");
    symlink(&reference.path, &alias).unwrap();
    let mut aliased = reference.clone();
    aliased.path = alias.to_string_lossy().into();
    assert!(read(&aliased).is_err());
}
