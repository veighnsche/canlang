//! Private canonical-root claim and verified Unix endpoint discovery.
//! A claim is retired explicitly after the controller confirms runtime release.
//! Dropping a claim never makes a still-running runtime's root available again.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, atomic::AtomicBool};
use std::time::{Duration, SystemTime};

pub const PROTOCOL: &str = "can.dev.control.v1";
const PARTIAL_GRACE: Duration = Duration::from_secs(10);
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlError {
    pub code: String,
    pub message: String,
}
impl ControlError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for ControlError {}
pub type Result<T> = std::result::Result<T, ControlError>;
fn io(error: std::io::Error) -> ControlError {
    ControlError::new("CONTROL_IO", error.to_string())
}
fn json(error: serde_json::Error) -> ControlError {
    ControlError::new("INVALID_DESCRIPTOR", error.to_string())
}

#[derive(Clone, Debug)]
pub struct Selection {
    pub checkout_root: String,
    pub app: String,
    pub profile: String,
    pub runtime_dir: Option<PathBuf>,
}
#[derive(Clone, Debug, Default)]
pub struct Lookup {
    pub checkout_root: String,
    pub app: Option<String>,
    pub profile: Option<String>,
    pub session_id: Option<String>,
    pub runtime_dir: Option<PathBuf>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub protocol: String,
    pub root: String,
    pub app: String,
    pub profile: String,
    pub session_id: String,
    pub pid: u32,
    pub uid: u32,
    pub process_start: String,
    pub socket_path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredClaim {
    root: String,
    session_id: String,
    pid: u32,
    uid: u32,
    process_start: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_birth: Option<String>,
}
impl StoredClaim {
    fn matches(&self, identity: &Identity) -> bool {
        self.root == identity.root
            && self.session_id == identity.session_id
            && self.pid == identity.pid
            && self.uid == identity.uid
            && self.process_start == identity.process_start
    }
}
#[derive(Clone, Debug)]
struct Paths {
    directory: PathBuf,
    claim: PathBuf,
    descriptor: PathBuf,
    socket: PathBuf,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Inode {
    dev: u64,
    ino: u64,
}
impl From<&fs::Metadata> for Inode {
    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }
}
fn uid() -> u32 {
    unsafe { libc::getuid() }
}
pub(crate) fn nonce(bytes: usize) -> Result<String> {
    let mut random = vec![0; bytes];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut random))
        .map_err(io)?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}
fn process_start() -> Result<String> {
    static START: OnceLock<String> = OnceLock::new();
    if let Some(start) = START.get() {
        return Ok(start.clone());
    }
    let start = nonce(16)?;
    Ok(START.get_or_init(|| start).clone())
}
fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| ControlError::new("INVALID_ROOT", "path is not UTF-8"))
}
fn canonical_root(path: &str) -> Result<String> {
    let canonical = fs::canonicalize(path).map_err(io)?;
    if !fs::metadata(&canonical).map_err(io)?.is_dir() {
        return Err(ControlError::new(
            "INVALID_ROOT",
            "checkout root is not a directory",
        ));
    }
    path_text(&canonical)
}
fn create_directory(path: &Path) -> Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(io(e)),
    }
}
fn private_directory(path: &Path, create: bool) -> Result<Inode> {
    if create {
        create_directory(path)?;
    }
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(ControlError::new(
            "INSECURE_RUNTIME_DIR",
            "control runtime directory is not owner-only",
        ));
    }
    Ok(Inode::from(&metadata))
}
pub(crate) fn private_file(path: &Path, socket: bool) -> Result<Inode> {
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    let correct_type = if socket {
        metadata.file_type().is_socket()
    } else {
        metadata.is_file()
    };
    if !correct_type
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(ControlError::new(
            "INSECURE_ENDPOINT",
            "control endpoint is not owner-only",
        ));
    }
    Ok(Inode::from(&metadata))
}
fn paths_for(root: &str, override_directory: &Option<PathBuf>, create: bool) -> Result<Paths> {
    let base = match override_directory {
        Some(path) => crate::capture::absolute(std::env::current_dir().map_err(io)?, path),
        None => fs::canonicalize(std::env::temp_dir())
            .map_err(io)?
            .join(format!("cv-{}", uid())),
    };
    private_directory(&base, create)?;
    let base = fs::canonicalize(&base).map_err(io)?;
    if base.starts_with(root) {
        return Err(ControlError::new(
            "INVALID_RUNTIME_DIR",
            "control runtime directory must be outside checkout",
        ));
    }
    let hash = format!("{:x}", Sha256::digest(root.as_bytes()));
    let directory = base.join(&hash[..24]);
    let socket = directory.join("s");
    if path_text(&socket)?.len() > 100 {
        return Err(ControlError::new(
            "SOCKET_PATH_TOO_LONG",
            "control socket path exceeds the portable Unix limit",
        ));
    }
    Ok(Paths {
        claim: directory.join("claim.json"),
        descriptor: directory.join("descriptor.json"),
        socket,
        directory,
    })
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 128 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
fn write_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(json)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(io)
}
fn proc_fields(entry: &str, pid: u32) -> Option<Vec<&str>> {
    if !entry.starts_with(&format!("{pid} (")) {
        return None;
    }
    let (_, rest) = entry.rsplit_once(')')?;
    let fields: Vec<_> = rest.split_whitespace().collect();
    if fields.len() < 20 || fields[0].len() != 1 || fields[19].parse::<u64>().is_err() {
        return None;
    }
    Some(fields)
}
fn proc_birth(pid: u32) -> Option<String> {
    let entry = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let fields = proc_fields(&entry, pid)?;
    if boot.trim().is_empty() {
        return None;
    }
    Some(format!("proc:{}:{}", boot.trim(), fields[19]))
}
fn process_birth(pid: u32, format: Option<&str>) -> Option<String> {
    if pid == 0 {
        return None;
    }
    if cfg!(target_os = "linux") && format != Some("ps") {
        if let Some(birth) = proc_birth(pid) {
            return Some(birth);
        }
    }
    if format == Some("proc") {
        return None;
    }
    let ps = if Path::new("/bin/ps").is_file() {
        Path::new("/bin/ps")
    } else {
        Path::new("/usr/bin/ps")
    };
    let output = crate::compiler::run_owned(
        ps,
        &["-o".into(), "lstart=".into(), "-p".into(), pid.to_string()],
        Path::new("/"),
        &[("LC_ALL", "C")],
        None,
        &AtomicBool::new(false),
        2,
        1024,
    )
    .ok()?;
    if output.code != Some(0) {
        return None;
    }
    let started = String::from_utf8(output.stdout)
        .ok()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if started.is_empty() {
        None
    } else {
        Some(format!("ps:{started}"))
    }
}
fn process_alive(claim: &StoredClaim) -> bool {
    if claim.pid == 0 || claim.pid > i32::MAX as u32 {
        return true;
    }
    let status = unsafe { libc::kill(claim.pid as i32, 0) };
    if status != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return false;
    }
    if cfg!(target_os = "linux") {
        if let Ok(entry) = fs::read_to_string(format!("/proc/{}/stat", claim.pid)) {
            if proc_fields(&entry, claim.pid).is_some_and(|f| matches!(f[0], "Z" | "X")) {
                return false;
            }
        }
    }
    let format = claim
        .process_birth
        .as_deref()
        .and_then(|s| s.split_once(':'))
        .map(|(kind, _)| kind);
    match format {
        Some("proc" | "ps") => process_birth(claim.pid, format)
            .is_none_or(|actual| Some(&actual) == claim.process_birth.as_ref()),
        _ => true,
    }
}
fn own_claim(root: &str, session: String) -> Result<StoredClaim> {
    Ok(StoredClaim {
        root: root.into(),
        session_id: session,
        pid: std::process::id(),
        uid: uid(),
        process_start: process_start()?,
        process_birth: process_birth(std::process::id(), None),
    })
}
fn young_directory(path: &Path) -> Result<bool> {
    let modified = fs::metadata(path).map_err(io)?.modified().map_err(io)?;
    Ok(SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        < PARTIAL_GRACE)
}
fn inode_now(path: &Path) -> Result<Option<Inode>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(Inode::from(&metadata))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io(e)),
    }
}
fn require_inode(path: &Path, inode: Inode) -> Result<()> {
    if inode_now(path)? != Some(inode) {
        return Err(ControlError::new(
            "CLAIM_LOST",
            "session directory changed during initialization or cleanup",
        ));
    }
    Ok(())
}
fn move_stale(path: &Path, expected: Inode) -> Result<PathBuf> {
    let moved = path.with_file_name(format!(
        "{}.stale-{}",
        path.file_name().unwrap().to_string_lossy(),
        nonce(8)?
    ));
    fs::rename(path, &moved).map_err(io)?;
    if inode_now(&moved)? != Some(expected) {
        if inode_now(path)?.is_none() {
            let _ = fs::rename(&moved, path);
        }
        return Err(ControlError::new(
            "RECOVERY_IN_PROGRESS",
            "directory changed during takeover",
        ));
    }
    Ok(moved)
}
struct RecoveryLock {
    path: PathBuf,
    inode: Inode,
    owner: StoredClaim,
}
impl RecoveryLock {
    fn acquire(root: &str, directory: &Path) -> Result<Self> {
        let path = directory.with_file_name(format!(
            "{}.recover",
            directory.file_name().unwrap().to_string_lossy()
        ));
        for _ in 0..5 {
            match fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => return Self::publish(root, path),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    Self::reclaim(root, &path)?
                }
                Err(e) => return Err(io(e)),
            }
        }
        Err(ControlError::new(
            "RECOVERY_IN_PROGRESS",
            "another process is recovering this session",
        ))
    }
    fn publish(root: &str, path: PathBuf) -> Result<Self> {
        let inode = private_directory(&path, false)?;
        let owner = own_claim(root, nonce(16)?)?;
        if let Err(error) = write_new(&path.join("owner.json"), &owner) {
            if inode_now(&path)? == Some(inode) {
                let _ = fs::remove_dir_all(&path);
            }
            return Err(error);
        }
        Ok(Self { path, inode, owner })
    }
    fn reclaim(root: &str, path: &Path) -> Result<()> {
        let inode = private_directory(path, false)?;
        let prior: Option<StoredClaim> = read_json(&path.join("owner.json"));
        if prior.as_ref().is_some_and(|owner| owner.root != root) {
            return Err(ControlError::new(
                "ROOT_COLLISION",
                "recovery lock belongs to another checkout",
            ));
        }
        let alive = match prior {
            Some(owner) => process_alive(&owner),
            None => young_directory(path)?,
        };
        if alive {
            return Err(ControlError::new(
                "RECOVERY_IN_PROGRESS",
                "another process is recovering this session",
            ));
        }
        let stale = move_stale(path, inode)?;
        fs::remove_dir_all(stale).map_err(io)
    }
}
impl Drop for RecoveryLock {
    fn drop(&mut self) {
        if inode_now(&self.path).ok().flatten() != Some(self.inode) {
            return;
        }
        let owner: Option<StoredClaim> = read_json(&self.path.join("owner.json"));
        if owner.is_some_and(|o| o.session_id == self.owner.session_id) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
fn reclaim_stale(root: &str, paths: &Paths) -> Result<Inode> {
    let recovery = RecoveryLock::acquire(root, &paths.directory)?;
    let prior_inode = private_directory(&paths.directory, false)?;
    let claim: Option<StoredClaim> = read_json(&paths.claim);
    let descriptor: Option<Identity> = read_json(&paths.descriptor);
    reject_live_or_foreign(root, paths, claim, descriptor)?;
    require_inode(&recovery.path, recovery.inode)?;
    let stale = move_stale(&paths.directory, prior_inode)?;
    let created = fs::DirBuilder::new()
        .mode(0o700)
        .create(&paths.directory)
        .map_err(io);
    let cleanup = fs::remove_dir_all(stale).map_err(io);
    created?;
    cleanup?;
    private_directory(&paths.directory, false)
}
fn reject_live_or_foreign(
    root: &str,
    paths: &Paths,
    claim: Option<StoredClaim>,
    descriptor: Option<Identity>,
) -> Result<()> {
    if claim.as_ref().is_some_and(|c| c.root != root)
        || descriptor.as_ref().is_some_and(|d| d.root != root)
    {
        return Err(ControlError::new(
            "ROOT_COLLISION",
            "session index belongs to another checkout",
        ));
    }
    if descriptor.as_ref().is_some_and(crate::control::verify_live) {
        return Err(ControlError::new(
            "SESSION_EXISTS",
            "a live session already owns this checkout",
        ));
    }
    if claim.as_ref().is_some_and(process_alive) {
        return Err(ControlError::new(
            "OWNER_UNRESPONSIVE",
            "session owner is alive but its control endpoint is unavailable",
        ));
    }
    if claim.is_none() && young_directory(&paths.directory)? {
        return Err(ControlError::new(
            "CLAIM_IN_PROGRESS",
            "session claim is still being created",
        ));
    }
    Ok(())
}

pub struct Claim {
    pub identity: Identity,
    paths: Paths,
    inode: Inode,
    stored: StoredClaim,
    listener: Option<UnixListener>,
    socket_inode: Option<Inode>,
    retired: bool,
}
impl Claim {
    /// Acquire, bind and publish. The exact directory inode is checked before
    /// each publication step; an interrupted live owner is never reclaimed.
    pub fn acquire(selection: &Selection) -> Result<Self> {
        if selection.app.is_empty() || selection.profile.is_empty() {
            return Err(ControlError::new(
                "INVALID_SELECTION",
                "app and profile are required",
            ));
        }
        let root = canonical_root(&selection.checkout_root)?;
        let paths = paths_for(&root, &selection.runtime_dir, true)?;
        let inode = match fs::DirBuilder::new().mode(0o700).create(&paths.directory) {
            Ok(()) => private_directory(&paths.directory, false)?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                reclaim_stale(&root, &paths)?
            }
            Err(e) => return Err(io(e)),
        };
        let stored = own_claim(&root, nonce(24)?)?;
        let identity = Identity {
            protocol: PROTOCOL.into(),
            root,
            app: selection.app.clone(),
            profile: selection.profile.clone(),
            session_id: stored.session_id.clone(),
            pid: stored.pid,
            uid: stored.uid,
            process_start: stored.process_start.clone(),
            socket_path: path_text(&paths.socket)?,
        };
        let mut claim = Self {
            identity,
            paths,
            inode,
            stored,
            listener: None,
            socket_inode: None,
            retired: false,
        };
        if let Err(error) = claim.publish() {
            claim.listener.take();
            if claim.owns(true).unwrap_or(false) {
                let _ = fs::remove_dir_all(&claim.paths.directory);
            }
            return Err(error);
        }
        Ok(claim)
    }
    fn publish(&mut self) -> Result<()> {
        self.require(true)?;
        write_new(&self.paths.claim, &self.stored)?;
        self.require(false)?;
        self.bind()?;
        self.require(false)?;
        let temporary = self
            .paths
            .directory
            .join(format!("descriptor-{}.tmp", self.identity.session_id));
        write_new(&temporary, &self.identity)?;
        self.require(false)?;
        fs::rename(temporary, &self.paths.descriptor).map_err(io)?;
        self.require(false)
    }
    fn bind(&mut self) -> Result<()> {
        self.require(true)?;
        let listener = UnixListener::bind(&self.paths.socket).map_err(io)?;
        fs::set_permissions(&self.paths.socket, fs::Permissions::from_mode(0o600)).map_err(io)?;
        listener.set_nonblocking(true).map_err(io)?;
        self.socket_inode = Some(private_file(&self.paths.socket, true)?);
        self.listener = Some(listener);
        Ok(())
    }
    fn owns(&self, missing: bool) -> Result<bool> {
        if inode_now(&self.paths.directory)? != Some(self.inode) {
            return Ok(false);
        }
        match fs::read(&self.paths.claim) {
            Ok(bytes) => Ok(serde_json::from_slice::<StoredClaim>(&bytes)
                .ok()
                .is_some_and(|claim| claim.matches(&self.identity))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(missing),
            Err(e) => Err(io(e)),
        }
    }
    fn require(&self, missing: bool) -> Result<()> {
        if !self.owns(missing)? {
            return Err(ControlError::new(
                "CLAIM_LOST",
                "session claim changed during initialization or cleanup",
            ));
        }
        Ok(())
    }
    pub fn require_ownership(&self) -> Result<()> {
        self.require(false)
    }
    pub fn descriptor_path(&self) -> &Path {
        &self.paths.descriptor
    }
    pub fn listener(&self) -> Option<&UnixListener> {
        self.listener.as_ref()
    }
    pub fn accept(&self) -> Result<Option<UnixStream>> {
        let Some(listener) = &self.listener else {
            return Ok(None);
        };
        match listener.accept() {
            Ok((stream, _)) => Ok(Some(stream)),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(io(e)),
        }
    }
    /// Call only after owned application resources have actually released.
    /// A fallible removal restores this endpoint in the same retained inode.
    pub fn retire(&mut self) -> Result<()> {
        if self.retired {
            return Ok(());
        }
        self.require(true)?;
        if let Err(error) = self.remove_endpoint() {
            let _ = self.restore_endpoint();
            return Err(error);
        }
        self.retired = true;
        Ok(())
    }
    fn remove_endpoint(&mut self) -> Result<()> {
        self.require(true)?;
        self.check_descriptor()?;
        for entry in fs::read_dir(&self.paths.directory).map_err(io)? {
            let entry = entry.map_err(io)?;
            if entry.file_name() == "s" {
                continue;
            }
            self.require(true)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(io)?;
            if metadata.is_dir() {
                fs::remove_dir_all(entry.path()).map_err(io)?;
            } else {
                fs::remove_file(entry.path()).map_err(io)?;
            }
        }
        self.require(true)?;
        self.remove_socket()?;
        self.listener.take();
        self.require(true)?;
        fs::remove_dir(&self.paths.directory).map_err(io)
    }
    fn check_descriptor(&self) -> Result<()> {
        match fs::read(&self.paths.descriptor) {
            Ok(bytes) => {
                let identity: Identity = serde_json::from_slice(&bytes).map_err(json)?;
                if identity != self.identity {
                    return Err(ControlError::new(
                        "CLAIM_LOST",
                        "control descriptor changed during cleanup",
                    ));
                }
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io(e)),
        }
    }
    fn remove_socket(&self) -> Result<()> {
        if let Some(current) = inode_now(&self.paths.socket)? {
            if self.socket_inode != Some(current) {
                return Err(ControlError::new(
                    "CLAIM_LOST",
                    "control socket changed during cleanup",
                ));
            }
            fs::remove_file(&self.paths.socket).map_err(io)?;
        }
        Ok(())
    }
    fn restore_endpoint(&mut self) -> Result<()> {
        self.require(true)?;
        self.check_descriptor()?;
        if inode_now(&self.paths.claim)?.is_none() {
            write_new(&self.paths.claim, &self.stored)?;
        }
        if inode_now(&self.paths.descriptor)?.is_none() {
            write_new(&self.paths.descriptor, &self.identity)?;
        }
        self.require(false)?;
        if inode_now(&self.paths.socket)?.is_none() || self.listener.is_none() {
            self.remove_socket()?;
            self.listener.take();
            self.bind()?;
        }
        self.require(false)
    }
}

/// Read private discovery data; Client adds a fresh nonce-bound handshake.
pub fn discover(lookup: &Lookup) -> Result<Identity> {
    let root = canonical_root(&lookup.checkout_root)?;
    let paths = paths_for(&root, &lookup.runtime_dir, false)?;
    private_directory(&paths.directory, false)?;
    private_file(&paths.descriptor, false)?;
    private_file(&paths.claim, false)?;
    let identity: Identity = read_json(&paths.descriptor)
        .ok_or_else(|| ControlError::new("INVALID_DESCRIPTOR", "session descriptor is invalid"))?;
    let stored: StoredClaim = read_json(&paths.claim)
        .ok_or_else(|| ControlError::new("INVALID_DESCRIPTOR", "session claim is invalid"))?;
    if identity.protocol != PROTOCOL
        || identity.root != root
        || identity.uid != uid()
        || identity.socket_path != path_text(&paths.socket)?
        || !stored.matches(&identity)
        || !process_alive(&stored)
    {
        return Err(ControlError::new(
            "INVALID_DESCRIPTOR",
            "session descriptor does not match this checkout and live owner",
        ));
    }
    check_selection(lookup, &identity)?;
    private_file(&paths.socket, true)?;
    Ok(identity)
}
fn check_selection(lookup: &Lookup, identity: &Identity) -> Result<()> {
    let mismatch = lookup.app.as_ref().is_some_and(|s| s != &identity.app)
        || lookup
            .profile
            .as_ref()
            .is_some_and(|s| s != &identity.profile)
        || lookup
            .session_id
            .as_ref()
            .is_some_and(|s| s != &identity.session_id);
    if mismatch {
        Err(ControlError::new(
            "SESSION_MISMATCH",
            "session selection does not match descriptor",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    pub(crate) fn selection() -> (tempfile::TempDir, tempfile::TempDir, Selection) {
        let root = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        fs::set_permissions(runtime.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let selection = Selection {
            checkout_root: path_text(root.path()).unwrap(),
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
    #[test]
    fn publishes_private_identity_and_refuses_live_unresponsive_owner() {
        let (_root, _runtime, selection) = selection();
        let mut claim = Claim::acquire(&selection).unwrap();
        assert!(claim.require_ownership().is_ok());
        let identity = discover(&lookup(&selection)).unwrap();
        assert_eq!(identity, claim.identity);
        assert_eq!(
            fs::metadata(&claim.paths.claim).unwrap().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&claim.paths.socket).unwrap().mode() & 0o777,
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
        assert!(!claim.paths.directory.exists());
    }
    #[test]
    fn inode_replacement_never_publishes_or_removes_foreign_claim() {
        let (_root, _runtime, selection) = selection();
        let mut claim = Claim::acquire(&selection).unwrap();
        let moved = claim.paths.directory.with_extension("old");
        fs::rename(&claim.paths.directory, &moved).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&claim.paths.directory)
            .unwrap();
        fs::write(&claim.paths.claim, b"foreign claim").unwrap();
        assert_eq!(claim.require_ownership().unwrap_err().code, "CLAIM_LOST");
        assert_eq!(claim.retire().unwrap_err().code, "CLAIM_LOST");
        assert_eq!(fs::read(&claim.paths.claim).unwrap(), b"foreign claim");
        assert!(!claim.paths.descriptor.exists());
    }
    #[test]
    fn partial_publication_is_held_then_dead_claim_is_reclaimed() {
        let (_root, _runtime, selection) = selection();
        let root = canonical_root(&selection.checkout_root).unwrap();
        let paths = paths_for(&root, &selection.runtime_dir, true).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&paths.directory)
            .unwrap();
        assert_eq!(
            Claim::acquire(&selection).err().unwrap().code,
            "CLAIM_IN_PROGRESS"
        );
        let mut stored = own_claim(&root, "stale-session".into()).unwrap();
        stored.pid = i32::MAX as u32;
        write_new(&paths.claim, &stored).unwrap();
        let mut claim = Claim::acquire(&selection).unwrap();
        assert_ne!(claim.identity.session_id, "stale-session");
        assert!(claim.require_ownership().is_ok());
        claim.retire().unwrap();
    }
    #[test]
    fn old_incomplete_claim_reclaims_only_after_grace() {
        let (_root, _runtime, selection) = selection();
        let root = canonical_root(&selection.checkout_root).unwrap();
        let paths = paths_for(&root, &selection.runtime_dir, true).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&paths.directory)
            .unwrap();
        File::open(&paths.directory)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(11)),
            )
            .unwrap();
        let mut claim = Claim::acquire(&selection).unwrap();
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
    fn changed_descriptor_refuses_release_and_retains_claim() {
        let (_root, _runtime, selection) = selection();
        let mut claim = Claim::acquire(&selection).unwrap();
        let mut foreign = claim.identity.clone();
        foreign.session_id = "foreign".into();
        fs::write(
            &claim.paths.descriptor,
            serde_json::to_vec(&foreign).unwrap(),
        )
        .unwrap();
        assert_eq!(claim.retire().unwrap_err().code, "CLAIM_LOST");
        assert!(claim.require_ownership().is_ok());
        assert!(claim.listener().is_some());
        fs::write(
            &claim.paths.descriptor,
            serde_json::to_vec(&claim.identity).unwrap(),
        )
        .unwrap();
        claim.retire().unwrap();
    }
    #[test]
    fn pid_birth_mismatch_and_proc_parser_are_conservative() {
        let pid = std::process::id();
        let mut owner = own_claim("root", "id".into()).unwrap();
        assert!(process_alive(&owner));
        if let Some(birth) = &mut owner.process_birth {
            birth.push_str("-old");
            assert!(!process_alive(&owner));
        }
        owner.process_birth = None;
        assert!(process_alive(&owner));
        assert!(proc_fields("malformed", pid).is_none());
        let line =
            format!("{pid} (name ) with spaces) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19");
        assert_eq!(proc_fields(&line, pid).unwrap()[19], "19");
    }
}
