//! Bounded immutable payloads for the private runtime process contract.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use tempfile::TempDir;

pub const MAX_FILE: u64 = 32 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRef {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Keep this allocation with the generation until runtime release succeeds.
pub struct Payloads {
    directory: TempDir,
    count: usize,
    bytes: u64,
}
impl Payloads {
    pub fn new() -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("can-dev-input-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            directory,
            count: 0,
            bytes: 0,
        })
    }
    pub fn write(&mut self, bytes: &[u8]) -> Result<FileRef, String> {
        if bytes.len() as u64 > MAX_FILE
            || self.count >= 16
            || self.bytes + bytes.len() as u64 > 64 * 1024 * 1024
        {
            return Err("runtime input payload limit exceeded".into());
        }
        let path = fs::canonicalize(self.directory.path())
            .map_err(|e| e.to_string())?
            .join(format!("{}.json", self.count));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        self.count += 1;
        self.bytes += bytes.len() as u64;
        Ok(FileRef {
            path: path
                .to_str()
                .ok_or("runtime payload path is not UTF-8")?
                .into(),
            bytes: bytes.len() as u64,
            sha256: hash(bytes),
        })
    }
    pub fn json<T: Serialize>(&mut self, value: &T) -> Result<FileRef, String> {
        self.write(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn read(reference: &FileRef) -> Result<Vec<u8>, String> {
    let path = Path::new(&reference.path);
    if !path.is_absolute() || reference.bytes > MAX_FILE || reference.sha256.len() != 64 {
        return Err("invalid runtime file reference".into());
    }
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    private(&before)?;
    if fs::canonicalize(path).map_err(|e| e.to_string())? != path {
        return Err("runtime file is not canonical".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    private(&metadata)?;
    if before.dev() != metadata.dev()
        || before.ino() != metadata.ino()
        || metadata.len() != reference.bytes
    {
        return Err("runtime file changed".into());
    }
    read_bytes(&mut file, reference)
}
fn private(metadata: &fs::Metadata) -> Result<(), String> {
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("runtime file is not private and regular".into());
    }
    Ok(())
}
fn read_bytes(file: &mut File, reference: &FileRef) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 != reference.bytes || hash(&bytes) != reference.sha256 {
        return Err("runtime file byte/hash mismatch".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
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
        let alias = files.directory.path().join("alias");
        symlink(&reference.path, &alias).unwrap();
        let mut aliased = reference.clone();
        aliased.path = alias.to_string_lossy().into();
        assert!(read(&aliased).is_err());
    }
}
