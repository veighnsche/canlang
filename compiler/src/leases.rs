//! Cooperative write leases, snapshots and run-journal recovery (BGI-04).
//!
//! One documented on-disk protocol shared byte-for-shape by both hosts: this
//! module and the Node `packages/cloudflare/src/generation/{leases,journal}.ts`
//! pair implement the same lock order, token format, lock-file layout and
//! journal schema. Either host's leases block the other's; either host can
//! recover a journal the other staged.
//!
//! ## Layout (all paths relative to the project root)
//!
//! - `can.generated/<unit-id>/<rel>` — current saved group per BGI-02.
//! - `.can/gen/locks/<escaped>.write.lock` — one exclusive write lease.
//! - `.can/gen/locks/<escaped>.read.<token>.lock` — one shared read lease
//!   per holder; any number may coexist while no write lease exists.
//! - `.can/gen/runs/<run-id>/journal.json` — the one full-run journal.
//! - `.can/gen/runs/<run-id>/old/<unit-id>/<rel>` — complete prior set.
//! - `.can/gen/runs/<run-id>/new/<unit-id>/<rel>` — staged replacements.
//! - `.can/gen/previous/<unit-id>/<rel>` — one retained previous group.
//!
//! ## Canonical lock order
//!
//! Every acquisition sorts its normalized relative paths byte-wise and takes
//! them in ascending order, releasing in reverse. All participants (capture,
//! accept, `edit.begin`, build readers) follow this order, so cooperative
//! writers cannot deadlock each other.
//!
//! ## Tokens and modes
//!
//! A token is `v1-` plus 16 lowercase hex digits, generated per acquisition.
//! Lock files carry `{version, holder, token, mode, path}` as JSON. Capture
//! and accept hold brief write leases on the participating source paths and
//! unit directories; long-running generation holds no write lease. Readers
//! take read leases only while copying bytes into an immutable snapshot.
//!
//! ## Journal protocol
//!
//! 1. `stage_journal` copies the complete current group of every scope unit
//!    into `old/`, writes every replacement into `new/`, then atomically
//!    writes `journal.json` with state `staged`.
//! 2. `mark_committed` atomically flips the journal to `committed`.
//! 3. `apply_committed` replaces files atomically per file (temporary file
//!    plus rename in the destination directory), copies the staged old set
//!    into `.can/gen/previous/` wholesale per scope unit, then resolves the
//!    journal to `journal.resolved.json`.
//!
//! `commit_journal` runs steps 2–3 together; the split exists so an
//! interruption between the flip and the last rename recovers honestly:
//! recovery of a `staged` journal verifies the untouched old set and resolves
//! it, while recovery of a `committed` journal finishes the new set. Both
//! directions refuse unexpected bytes, write `conflict.json` beside the
//! journal, and retain staged payload plus current files for reconciliation.
//! Repeated recovery is idempotent: a resolved journal reports
//! `AlreadyResolved` without touching files.
//!
//! Builds never consume an unresolved mixed group: any `journal.json` still
//! present under `.can/gen/runs/` makes [`snapshot_inputs`] (and the
//! [`crate::source::snapshot_consumed_inputs`] reader hook) fail before any
//! byte is read.
//!
//! ## Stopped writers
//!
//! Leases never expire and are never stolen. [`recover_stopped_writer`]
//! removes one confirmed-stopped holder's lock files only, and only when the
//! caller passes explicit confirmation. Unknown writer activity stays unknown.
//!
//! ## Durability
//!
//! [`platform_durability`] states the qualified platform behavior: POSIX
//! atomic rename with file fsync (Linux/macOS); anything else is best-effort
//! and surfaces rename failures instead of claiming them. This protocol is
//! cooperative file replacement, never filesystem compare-and-swap and never
//! protection against writers that ignore leases.
//!
//! ## Dispatcher hook API
//!
//! The BGI-03 CLI dispatcher owns `cli.rs` and calls this stable surface:
//! [`acquire`]/[`release`] for `edit.begin`/`edit.end` and capture/accept
//! fences, [`stage_journal`]/[`commit_journal`]/[`recover_journal`] for
//! promotion, [`snapshot_inputs`] for read-gated builds, and
//! [`recover_stopped_writer`] for interrupted-lease recovery.

use crate::analysis::generation_intake::{GENERATED_DIR, GenerationUnitId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Lock-file and conflict-report protocol version.
pub const PROTOCOL_VERSION: u32 = 1;
/// Journal v2 adds explicit deletions and complete-group replacement.
pub const JOURNAL_VERSION: u32 = 2;
/// Ignored tooling root for locks, runs and retained groups.
pub const TOOL_DIR: &str = ".can/gen";
/// Directory holding lock files.
pub const LOCKS_DIR: &str = ".can/gen/locks";
/// Directory holding one subdirectory per promotion run.
pub const RUNS_DIR: &str = ".can/gen/runs";
/// Directory holding one retained previous group per unit.
pub const PREVIOUS_DIR: &str = ".can/gen/previous";
/// Unresolved-journal filename inside a run directory.
pub const JOURNAL_FILE: &str = "journal.json";
/// Resolved-journal filename (evidence retained after recovery/apply).
pub const RESOLVED_JOURNAL_FILE: &str = "journal.resolved.json";
/// Conflict-evidence filename written beside an unresolvable journal.
pub const CONFLICT_FILE: &str = "conflict.json";
/// Complete prior set inside a run directory.
pub const OLD_DIR: &str = "old";
/// Staged replacements inside a run directory.
pub const NEW_DIR: &str = "new";

/// Machine-readable failure from any lease/journal operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseError {
    /// Stable code: `conflict`, `unresolved-journal`, `unexpected-bytes`,
    /// `not-committed`, `already-staged`, `already-resolved`, `no-journal`,
    /// `stale-token`, `not-confirmed`, `invalid-path`, `invalid-id`,
    /// `invalid-token` or `io`.
    pub code: &'static str,
    /// Human-readable detail naming the path, run or token involved.
    pub message: String,
}

impl LeaseError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LeaseError {}

/// The qualified durability statement for this platform build.
///
/// POSIX (Linux/macOS) gets atomic rename with file fsync before the rename
/// and a best-effort directory fsync after. Other platforms use the same
/// calls and surface any failure; the protocol never claims universal
/// compare-and-swap.
pub fn platform_durability() -> &'static str {
    if cfg!(unix) {
        "POSIX atomic rename with file fsync before rename and best-effort directory fsync (qualified on Linux/macOS); cooperative replacement only, not filesystem CAS"
    } else {
        "rename-based replacement is best-effort on this platform and failures diagnose; cooperative replacement only, not filesystem CAS"
    }
}

/// Validate a root-relative path: `/`-separated, no leading slash, no empty,
/// `.` or `..` segments, no backslashes. Shared with the Node host.
pub fn validate_rel(path: &str) -> Result<(), LeaseError> {
    if path.is_empty() {
        return Err(LeaseError::new("invalid-path", "path must not be empty"));
    }
    if path.starts_with('/') || path.contains('\\') {
        return Err(LeaseError::new(
            "invalid-path",
            format!("path `{path}` must be root-relative with `/` separators"),
        ));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(LeaseError::new(
                "invalid-path",
                format!("path `{path}` must not contain empty, `.` or `..` segments"),
            ));
        }
    }
    Ok(())
}

/// Validate a run ID with the same rule as BGI-02 unit IDs: non-empty, no
/// path separators or whitespace, never `.`/`..`. Shared with Node.
pub fn validate_run_id(run_id: &str) -> Result<(), LeaseError> {
    GenerationUnitId::parse(run_id)
        .map(|_| ())
        .map_err(|detail| LeaseError::new("invalid-id", format!("run id: {detail}")))
}

/// Validate a unit ID with the accepted BGI-02 rule (read-only reuse).
pub fn validate_unit_id(unit: &str) -> Result<GenerationUnitId, LeaseError> {
    GenerationUnitId::parse(unit).map_err(|detail| LeaseError::new("invalid-id", detail))
}

/// Escape a validated relative path into one lock-file stem: every byte
/// outside `[A-Za-z0-9._-]` becomes `%XX` (uppercase hex). Both hosts must
/// produce identical stems; see the cross-host vector in the tests.
pub fn escape_rel(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-' {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Canonical lock order: validated paths sorted byte-wise ascending.
/// Acquire in this order; release in reverse.
pub fn canonical_order(paths: &[&str]) -> Result<Vec<String>, LeaseError> {
    for path in paths {
        validate_rel(path)?;
    }
    let mut ordered: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
    ordered.sort();
    ordered.dedup();
    Ok(ordered)
}

/// A lease token: `v1-` plus 16 lowercase hex digits. Tokens identify one
/// acquisition; they are never reused across acquisitions.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LeaseToken(String);

impl LeaseToken {
    /// Parse and strictly validate a token spelling.
    pub fn parse(text: &str) -> Result<Self, LeaseError> {
        let suffix = text.strip_prefix("v1-").ok_or_else(|| {
            LeaseError::new(
                "invalid-token",
                format!("token `{text}` must start with `v1-`"),
            )
        })?;
        if suffix.len() != 16
            || !suffix
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(LeaseError::new(
                "invalid-token",
                format!("token `{text}` must be `v1-` plus 16 lowercase hex digits"),
            ));
        }
        Ok(Self(text.to_string()))
    }

    /// The token text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for LeaseToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Mint a fresh token from process identity, time and a counter, hashed so
/// the spelling carries no meaning. Cooperative only: exclusivity comes from
/// exclusive lock-file creation, not from token secrecy.
pub fn new_token() -> LeaseToken {
    let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!("{}-{nanos}-{counter}", std::process::id());
    let digest = crate::source::sha256_hex(seed.as_bytes());
    LeaseToken(format!("v1-{}", &digest[..16]))
}

/// Read (shared) or write (exclusive) lease mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseMode {
    Read,
    Write,
}

impl LeaseMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

/// One lock acquisition over canonical-order paths, held under one token.
/// The BGI-03 dispatcher passes this to [`release`] or keeps it across a
/// capture/accept fence; dropping it does not release (explicit release
/// keeps crash evidence on disk for [`recover_stopped_writer`]).
#[derive(Debug, Clone)]
pub struct LeaseSet {
    /// Human/tool holder name recorded in each lock file.
    pub holder: String,
    /// Token recorded in each lock file; release must present the same one.
    pub token: LeaseToken,
    /// Mode of every lock file in the set.
    pub mode: LeaseMode,
    /// Held paths in canonical lock order.
    pub paths: Vec<String>,
}

/// Lock-file body, shared JSON shape with the Node host.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockFile {
    version: u32,
    holder: String,
    token: String,
    mode: String,
    path: String,
}

fn locks_dir(root: &Path) -> PathBuf {
    root.join(LOCKS_DIR)
}

fn write_lock_path(root: &Path, rel: &str) -> PathBuf {
    locks_dir(root).join(format!("{}.write.lock", escape_rel(rel)))
}

fn read_lock_path(root: &Path, rel: &str, token: &LeaseToken) -> PathBuf {
    locks_dir(root).join(format!("{}.read.{}.lock", escape_rel(rel), token.as_str()))
}

/// Any read lock currently present for `rel`, whatever its holder/token.
fn present_read_locks(root: &Path, rel: &str) -> Vec<PathBuf> {
    let prefix = format!("{}.read.", escape_rel(rel));
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(locks_dir(root)) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && name.ends_with(".lock") {
            found.push(entry.path());
        }
    }
    found.sort();
    found
}

fn io_error(context: impl Into<String>, error: std::io::Error) -> LeaseError {
    LeaseError::new("io", format!("{}: {error}", context.into()))
}

/// Acquire `mode` over `paths` for `holder`, in canonical lock order.
///
/// A write acquisition conflicts with any present write or read lock on the
/// same path; a read acquisition conflicts only with a present write lock.
/// On conflict this releases any prefix already taken (in reverse order) and
/// reports the conflicting path.
///
/// Admission is one shared atomic step per path: our mode lock is created
/// exclusively, then re-checked for a conflicting lock before the path
/// counts as held. A racing incompatible lease created its own
/// different-named file; whoever observes the other backs off by removing
/// its just-created lock, so incompatible exact-path leases can never both
/// be admitted. Exact simultaneity reports `conflict` on both sides and
/// cooperative callers retry. Read-sharing, exact ownership/tokens, and
/// stopped-writer recovery are unchanged: this arbitrates cooperative
/// writers only, never filesystem CAS.
fn check_lease_conflict(
    root: &Path,
    rel: &str,
    held: &[String],
    mode: LeaseMode,
    token: &LeaseToken,
) -> Result<(), LeaseError> {
    if write_lock_path(root, rel).exists() {
        release_paths(root, held, mode, token)?;
        return Err(LeaseError::new(
            "conflict",
            format!(
                "{} lease on `{rel}` conflicts with a held write lease",
                mode.as_str()
            ),
        ));
    }
    if mode == LeaseMode::Write && !present_read_locks(root, rel).is_empty() {
        release_paths(root, held, mode, token)?;
        return Err(LeaseError::new(
            "conflict",
            format!("write lease on `{rel}` conflicts with a held read lease"),
        ));
    }
    Ok(())
}

fn create_lease_lock(
    root: &Path,
    rel: &str,
    holder: &str,
    mode: LeaseMode,
    token: &LeaseToken,
    held: &[String],
) -> Result<PathBuf, LeaseError> {
    let body = LockFile {
        version: PROTOCOL_VERSION,
        holder: holder.to_string(),
        token: token.as_str().to_string(),
        mode: mode.as_str().to_string(),
        path: rel.to_string(),
    };
    let text = serde_json::to_string(&body).map_err(|e| io_error("encode lock", e.into()))?;
    let lock_path = match mode {
        LeaseMode::Write => write_lock_path(root, rel),
        LeaseMode::Read => read_lock_path(root, rel, token),
    };
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(mut file) => {
            file.write_all(text.as_bytes())
                .map_err(|e| io_error("write lock", e))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            release_paths(root, held, mode, token)?;
            return Err(LeaseError::new(
                "conflict",
                format!(
                    "{} lease on `{rel}` lost a racing acquisition",
                    mode.as_str()
                ),
            ));
        }
        Err(e) => {
            release_paths(root, held, mode, token)?;
            return Err(io_error("create lock", e));
        }
    }
    Ok(lock_path)
}

fn withdraw_raced_lock(
    root: &Path,
    rel: &str,
    mode: LeaseMode,
    token: &LeaseToken,
    held: &[String],
    lock_path: &Path,
) -> Result<(), LeaseError> {
    // Admission arbitration: a racing incompatible lease passed its own
    // pre-check and created a different-named file. Whoever observes the
    // other removes its just-created lock and reports conflict.
    let raced = match mode {
        LeaseMode::Read => write_lock_path(root, rel).exists(),
        LeaseMode::Write => !present_read_locks(root, rel).is_empty(),
    };
    if !raced {
        return Ok(());
    }
    match fs::remove_file(lock_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_error("withdraw racing lock", e)),
    }
    release_paths(root, held, mode, token)?;
    Err(LeaseError::new(
        "conflict",
        format!(
            "{} lease on `{rel}` lost a racing acquisition",
            mode.as_str()
        ),
    ))
}

pub fn acquire(
    root: &Path,
    paths: &[&str],
    mode: LeaseMode,
    holder: &str,
) -> Result<LeaseSet, LeaseError> {
    let ordered = canonical_order(paths)?;
    if holder.is_empty() {
        return Err(LeaseError::new("invalid-id", "holder must not be empty"));
    }
    fs::create_dir_all(locks_dir(root)).map_err(|e| io_error("create locks dir", e))?;
    let token = new_token();
    let mut held: Vec<String> = Vec::new();
    for rel in &ordered {
        check_lease_conflict(root, rel, &held, mode, &token)?;
        let lock_path = create_lease_lock(root, rel, holder, mode, &token, &held)?;
        withdraw_raced_lock(root, rel, mode, &token, &held, &lock_path)?;
        held.push(rel.clone());
    }
    Ok(LeaseSet {
        holder: holder.to_string(),
        token,
        mode,
        paths: ordered,
    })
}

fn release_paths(
    root: &Path,
    held: &[String],
    mode: LeaseMode,
    token: &LeaseToken,
) -> Result<(), LeaseError> {
    for rel in held.iter().rev() {
        let lock_path = match mode {
            LeaseMode::Write => write_lock_path(root, rel),
            LeaseMode::Read => read_lock_path(root, rel, token),
        };
        match fs::remove_file(&lock_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("release lock", e)),
        }
    }
    Ok(())
}

/// Release every path in `set`, in reverse canonical order.
///
/// Each lock file must still carry the set's token; a mismatched token
/// reports `stale-token` and leaves the foreign lock untouched (never steal).
/// A vanished lock file counts as released, so release is idempotent.
pub fn release(root: &Path, set: &LeaseSet) -> Result<(), LeaseError> {
    for rel in set.paths.iter().rev() {
        let lock_path = match set.mode {
            LeaseMode::Write => write_lock_path(root, rel),
            LeaseMode::Read => read_lock_path(root, rel, &set.token),
        };
        let text = match fs::read_to_string(&lock_path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_error("read lock for release", e)),
        };
        let body: LockFile = serde_json::from_str(&text)
            .map_err(|e| LeaseError::new("io", format!("decode lock: {e}")))?;
        if body.token != set.token.as_str() {
            return Err(LeaseError::new(
                "stale-token",
                format!(
                    "lock on `{rel}` now belongs to token `{}`; refusing to steal it",
                    body.token
                ),
            ));
        }
        match fs::remove_file(&lock_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("release lock", e)),
        }
    }
    Ok(())
}

/// Explicit stopped-writer lease recovery: remove the lock files belonging to
/// (`holder`, `token`) and return their paths in canonical order.
///
/// `confirmed_stopped` must be true: the caller confirms the writer process
/// has stopped, since leases never expire and unknown activity stays unknown.
/// Only that holder's locks are removed; every other lock file is untouched.
pub fn recover_stopped_writer(
    root: &Path,
    holder: &str,
    token: &LeaseToken,
    confirmed_stopped: bool,
) -> Result<Vec<String>, LeaseError> {
    if !confirmed_stopped {
        return Err(LeaseError::new(
            "not-confirmed",
            "lease recovery requires confirmation that the writer has stopped; leases never expire",
        ));
    }
    let mut recovered = Vec::new();
    let Ok(entries) = fs::read_dir(locks_dir(root)) else {
        return Ok(recovered);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("lock") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(body) = serde_json::from_str::<LockFile>(&text) else {
            continue;
        };
        if body.holder == holder && body.token == token.as_str() {
            validate_rel(&body.path)?;
            fs::remove_file(&path).map_err(|e| io_error("recover lock", e))?;
            recovered.push(body.path);
        }
    }
    recovered.sort();
    recovered.dedup();
    Ok(recovered)
}

/// One staged file replacement inside a run journal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    /// Owning unit; always a member of the journal scope.
    pub unit: String,
    /// Unit-relative path of the replaced file.
    pub path: String,
    /// SHA-256 of the current bytes at stage time; `None` when the file is
    /// new in this run.
    pub old_sha256: Option<String>,
    /// Run-relative staged payload (`new/<unit>/<rel>`); absent for deletion.
    pub staged: Option<String>,
    /// SHA-256 of staged replacement bytes; absent for deletion.
    pub new_sha256: Option<String>,
}

/// Journal lifecycle state. `staged` means nothing current has been touched;
/// `committed` means per-file replacement is underway or done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JournalState {
    Staged,
    Committed,
}

/// The one full-run journal: every old/replacement group in the run's scope.
/// Shared JSON schema with the Node host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunJournal {
    /// [`JOURNAL_VERSION`]; version 1 patch journals remain readable.
    pub version: u32,
    /// Run identity; the run directory name.
    pub run_id: String,
    /// Every unit whose groups participate, in canonical order.
    pub scope: Vec<String>,
    /// Lifecycle state.
    pub state: JournalState,
    /// Version 1 journals omit this field and describe patches.
    #[serde(default)]
    pub mode: JournalMode,
    /// One entry per added, replaced or deleted file, in canonical order.
    pub entries: Vec<JournalEntry>,
}

/// A patch preserves omitted files; a replacement removes omitted owned files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JournalMode {
    #[default]
    Patch,
    Replace,
}

/// One caller-supplied replacement for [`stage_journal`].
#[derive(Debug, Clone)]
pub struct Replacement {
    /// Owning unit; must be a member of the stage scope.
    pub unit: String,
    /// Unit-relative destination path.
    pub path: String,
    /// Replacement bytes.
    pub bytes: Vec<u8>,
}

fn run_dir(root: &Path, run_id: &str) -> PathBuf {
    root.join(RUNS_DIR).join(run_id)
}

fn group_dir(root: &Path, unit: &str) -> PathBuf {
    root.join(GENERATED_DIR).join(unit)
}

/// Join a validated relative path onto `base` without traversal.
fn join_rel(base: &Path, rel: &str) -> Result<PathBuf, LeaseError> {
    validate_rel(rel)?;
    let mut joined = base.to_path_buf();
    for segment in rel.split('/') {
        joined.push(segment);
    }
    Ok(joined)
}

fn sha256_of(bytes: &[u8]) -> String {
    crate::source::sha256_hex(bytes)
}

/// Write `bytes` atomically: temporary sibling, fsync, rename, best-effort
/// directory fsync. The temporary name is unique per process call.
pub(crate) fn persist_file(path: &Path, bytes: &[u8]) -> Result<(), LeaseError> {
    let parent = path.parent().ok_or_else(|| {
        LeaseError::new("invalid-path", "target has no parent directory".to_string())
    })?;
    fs::create_dir_all(parent).map_err(|e| io_error("create target dir", e))?;
    let tmp = parent.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = File::create(&tmp).map_err(|e| io_error("create temp file", e))?;
    file.write_all(bytes)
        .map_err(|e| io_error("write temp file", e))?;
    file.sync_all()
        .map_err(|e| io_error("fsync temp file", e))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| io_error("atomic rename", e))?;
    // Best-effort directory fsync: durable on POSIX, ignored where the
    // platform cannot sync a directory handle.
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Copy a directory tree; used for whole-group old-set and previous copies.
fn copy_tree(src: &Path, dst: &Path) -> Result<(), LeaseError> {
    fs::create_dir_all(dst).map_err(|e| io_error("create copy dir", e))?;
    let entries = fs::read_dir(src).map_err(|e| io_error("read copy source", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_error("read copy entry", e))?;
        let target = dst.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| io_error("stat copy entry", e))?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| io_error("create copy dir", e))?;
            }
            fs::copy(entry.path(), &target).map_err(|e| io_error("copy file", e))?;
        }
    }
    Ok(())
}

/// List every file under `dir` as `/`-separated paths relative to `dir`.
fn list_files_rel(dir: &Path) -> Result<Vec<String>, LeaseError> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), LeaseError> {
        let entries = fs::read_dir(dir).map_err(|e| io_error("list group dir", e))?;
        for entry in entries {
            let entry = entry.map_err(|e| io_error("list group entry", e))?;
            let kind = entry
                .file_type()
                .map_err(|e| io_error("stat group entry", e))?;
            if kind.is_dir() {
                walk(base, &entry.path(), out)?;
            } else if kind.is_file() {
                let rel = entry
                    .path()
                    .strip_prefix(base)
                    .map_err(|e| LeaseError::new("io", format!("relativize group file: {e}")))?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel);
            }
        }
        Ok(())
    }
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    out.sort();
    Ok(out)
}

/// Remove a directory tree when present; absent counts as removed.
fn remove_tree(path: &Path) -> Result<(), LeaseError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error("remove dir tree", e)),
    }
}

/// Stage one full-run journal: copy every scope unit's complete current group
/// into `old/`, write every replacement into `new/`, then atomically write
/// `journal.json` with state `staged`.
///
/// The run directory must be fresh (`create_dir` exclusivity makes a reused
/// run id fail instead of mixing runs). The caller holds the capture/accept
/// write leases; staging itself never touches current files.
pub fn stage_journal(
    root: &Path,
    run_id: &str,
    scope: &[&str],
    replacements: &[Replacement],
) -> Result<RunJournal, LeaseError> {
    stage_journal_with_mode(root, run_id, scope, replacements, &[], JournalMode::Patch)
}

/// Stage an exact new group set, deleting current files omitted by the caller.
pub fn stage_complete_journal(
    root: &Path,
    run_id: &str,
    scope: &[&str],
    replacements: &[Replacement],
) -> Result<RunJournal, LeaseError> {
    stage_journal_with_mode(root, run_id, scope, replacements, &[], JournalMode::Replace)
}

/// Stage a patch with explicit deleted `(unit, path)` pairs; omitted paths survive.
pub fn stage_journal_with_deletions(
    root: &Path,
    run_id: &str,
    scope: &[&str],
    replacements: &[Replacement],
    deletions: &[(&str, &str)],
) -> Result<RunJournal, LeaseError> {
    stage_journal_with_mode(
        root,
        run_id,
        scope,
        replacements,
        deletions,
        JournalMode::Patch,
    )
}

fn prepare_journal_scope(scope: &[&str]) -> Result<Vec<String>, LeaseError> {
    let mut ordered_scope: Vec<String> = Vec::new();
    for unit in scope {
        let parsed = validate_unit_id(unit)?;
        ordered_scope.push(parsed.as_str().to_string());
    }
    ordered_scope.sort();
    ordered_scope.dedup();
    if ordered_scope.is_empty() {
        return Err(LeaseError::new(
            "invalid-id",
            "journal scope must name at least one unit",
        ));
    }
    Ok(ordered_scope)
}

fn snapshot_journal_units(
    root: &Path,
    dir: &Path,
    ordered_scope: &[String],
) -> Result<(), LeaseError> {
    // Complete prior set first: every scope unit's whole current group.
    for unit in ordered_scope {
        let group = group_dir(root, unit);
        let old_unit = dir.join(OLD_DIR).join(unit);
        if group.exists() {
            copy_tree(&group, &old_unit)?;
        } else {
            fs::create_dir_all(&old_unit).map_err(|e| io_error("create old unit dir", e))?;
        }
    }
    Ok(())
}

fn collect_journal_changes(
    replacements: &[Replacement],
    deletions: &[(&str, &str)],
    mode: JournalMode,
    dir: &Path,
    ordered_scope: &[String],
) -> Result<Vec<(String, String, Option<Vec<u8>>)>, LeaseError> {
    let mut changes: Vec<(String, String, Option<Vec<u8>>)> = replacements
        .iter()
        .map(|r| (r.unit.clone(), r.path.clone(), Some(r.bytes.clone())))
        .collect();
    changes.extend(
        deletions
            .iter()
            .map(|(unit, path)| (unit.to_string(), path.to_string(), None)),
    );
    if mode == JournalMode::Replace {
        for unit in ordered_scope {
            for path in list_files_rel(&dir.join(OLD_DIR).join(unit))? {
                if !replacements
                    .iter()
                    .any(|r| r.unit == *unit && r.path == path)
                {
                    changes.push((unit.clone(), path, None));
                }
            }
        }
    }
    Ok(changes)
}

fn build_journal_entries(
    root: &Path,
    dir: &Path,
    ordered_scope: &[String],
    changes: &[(String, String, Option<Vec<u8>>)],
) -> Result<Vec<JournalEntry>, LeaseError> {
    let mut entries: Vec<JournalEntry> = Vec::new();
    let mut seen: BTreeMap<(String, String), ()> = BTreeMap::new();
    for (unit_name, path, bytes) in changes {
        let unit = validate_unit_id(unit_name)?;
        if !ordered_scope.iter().any(|s| s == unit.as_str()) {
            return Err(LeaseError::new(
                "invalid-id",
                format!(
                    "replacement unit `{}` is outside the run scope",
                    unit.as_str()
                ),
            ));
        }
        validate_rel(path)?;
        let key = (unit.as_str().to_string(), path.clone());
        if seen.insert(key, ()).is_some() {
            return Err(LeaseError::new(
                "invalid-path",
                format!(
                    "duplicate replacement for `{}` in unit `{}`",
                    *path,
                    unit.as_str()
                ),
            ));
        }
        let current = group_dir(root, unit.as_str()).join(path);
        let old_sha256 = current_sha256(&current)?;
        let staged_rel = bytes
            .as_ref()
            .map(|_| format!("{NEW_DIR}/{}/{}", unit.as_str(), path));
        if let (Some(staged), Some(bytes)) = (&staged_rel, bytes) {
            persist_file(&join_rel(dir, staged)?, bytes)?;
        }
        entries.push(JournalEntry {
            unit: unit.as_str().to_string(),
            path: path.clone(),
            old_sha256,
            staged: staged_rel,
            new_sha256: bytes.as_ref().map(|bytes| sha256_of(bytes)),
        });
    }
    entries.sort_by(|a, b| (&a.unit, &a.path).cmp(&(&b.unit, &b.path)));
    Ok(entries)
}

fn stage_journal_with_mode(
    root: &Path,
    run_id: &str,
    scope: &[&str],
    replacements: &[Replacement],
    deletions: &[(&str, &str)],
    mode: JournalMode,
) -> Result<RunJournal, LeaseError> {
    validate_run_id(run_id)?;
    let ordered_scope = prepare_journal_scope(scope)?;
    let dir = run_dir(root, run_id);
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| io_error("create runs dir", e))?;
    }
    match fs::create_dir(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(LeaseError::new(
                "already-staged",
                format!("run `{run_id}` is already staged; recover it or use a fresh run id"),
            ));
        }
        Err(e) => return Err(io_error("create run dir", e)),
    }
    snapshot_journal_units(root, &dir, &ordered_scope)?;
    let changes = collect_journal_changes(replacements, deletions, mode, &dir, &ordered_scope)?;
    let entries = build_journal_entries(root, &dir, &ordered_scope, &changes)?;
    let journal = RunJournal {
        version: JOURNAL_VERSION,
        mode,
        run_id: run_id.to_string(),
        scope: ordered_scope,
        state: JournalState::Staged,
        entries,
    };
    let text =
        serde_json::to_string_pretty(&journal).map_err(|e| io_error("encode journal", e.into()))?;
    persist_file(&dir.join(JOURNAL_FILE), text.as_bytes())?;
    Ok(journal)
}

/// Read a run's unresolved journal; fails when the run was never staged or
/// is already resolved.
pub fn read_journal(root: &Path, run_id: &str) -> Result<RunJournal, LeaseError> {
    validate_run_id(run_id)?;
    let path = run_dir(root, run_id).join(JOURNAL_FILE);
    let text = fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            let resolved = run_dir(root, run_id).join(RESOLVED_JOURNAL_FILE);
            if resolved.exists() {
                return LeaseError::new(
                    "already-resolved",
                    format!("run `{run_id}` is already resolved"),
                );
            }
            return LeaseError::new("no-journal", format!("run `{run_id}` was never staged"));
        }
        io_error("read journal", e)
    })?;
    let journal: RunJournal = serde_json::from_str(&text)
        .map_err(|e| LeaseError::new("io", format!("decode journal: {e}")))?;
    if journal.version != 1 && journal.version != JOURNAL_VERSION {
        return Err(LeaseError::new(
            "io",
            format!("journal version {} is not supported", journal.version),
        ));
    }
    validate_journal(&journal, run_id)?;
    Ok(journal)
}

fn validate_journal(journal: &RunJournal, run_id: &str) -> Result<(), LeaseError> {
    if journal.run_id != run_id || journal.scope.is_empty() {
        return Err(LeaseError::new("io", "invalid journal identity or scope"));
    }
    let mut scope = BTreeMap::new();
    for unit in &journal.scope {
        validate_unit_id(unit)?;
        if scope.insert(unit, ()).is_some() {
            return Err(LeaseError::new("io", "duplicate journal scope"));
        }
    }
    let mut seen = BTreeMap::new();
    for entry in &journal.entries {
        validate_unit_id(&entry.unit)?;
        validate_rel(&entry.path)?;
        if !scope.contains_key(&entry.unit) || seen.insert((&entry.unit, &entry.path), ()).is_some()
        {
            return Err(LeaseError::new("io", "invalid journal entry scope"));
        }
        if entry.staged.is_some() != entry.new_sha256.is_some()
            || entry
                .staged
                .as_ref()
                .is_some_and(|path| *path != format!("{NEW_DIR}/{}/{}", entry.unit, entry.path))
            || (journal.version == 1 && entry.new_sha256.is_none())
        {
            return Err(LeaseError::new(
                "io",
                "invalid journal staged payload/deletion",
            ));
        }
        for hash in [&entry.old_sha256, &entry.new_sha256].into_iter().flatten() {
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(LeaseError::new("io", "invalid journal content hash"));
            }
        }
    }
    Ok(())
}

fn write_journal_state(root: &Path, journal: &RunJournal) -> Result<(), LeaseError> {
    let text =
        serde_json::to_string_pretty(journal).map_err(|e| io_error("encode journal", e.into()))?;
    persist_file(
        &run_dir(root, &journal.run_id).join(JOURNAL_FILE),
        text.as_bytes(),
    )
}

/// Flip a staged journal to committed, atomically. After this point recovery
/// finishes the whole new set; before it, recovery keeps the whole old set.
/// The dispatcher calls [`commit_journal`]; this split names the interruption
/// boundary between the flip and the last per-file rename.
pub fn mark_committed(root: &Path, run_id: &str) -> Result<RunJournal, LeaseError> {
    let mut journal = read_journal(root, run_id)?;
    if journal.state != JournalState::Staged {
        return Err(LeaseError::new(
            "not-committed",
            format!("run `{run_id}` is already committed; apply or recover it"),
        ));
    }
    journal.state = JournalState::Committed;
    write_journal_state(root, &journal)?;
    Ok(journal)
}

/// One file whose current bytes match neither the staged old nor the new
/// hash: a participating edit or foreign write landed mid-run. Recovery and
/// apply stop at the first mismatch and retain everything.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ByteMismatch {
    /// Owning unit.
    pub unit: String,
    /// Unit-relative path.
    pub path: String,
    /// Expected hash: old for staged recovery, old-or-new for apply.
    pub expected_sha256: Option<String>,
    /// Observed current hash; `None` when the file is missing.
    pub observed_sha256: Option<String>,
}

/// Conflict evidence written to `conflict.json` beside an unresolvable
/// journal. Shared shape with the Node host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictReport {
    /// Always [`PROTOCOL_VERSION`].
    pub version: u32,
    /// Run that found the unexpected bytes.
    pub run_id: String,
    /// What the run was doing: `apply` or `recover`.
    pub phase: String,
    /// Every mismatch found before stopping.
    pub mismatches: Vec<ByteMismatch>,
    /// Retained material: staged payload, current files and the journal.
    pub retained: Vec<String>,
}

fn current_sha256(path: &Path) -> Result<Option<String>, LeaseError> {
    if path.is_dir() {
        return Ok(None);
    }
    match fs::read(path) {
        Ok(bytes) => Ok(Some(sha256_of(&bytes))),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(io_error("read current file", e)),
    }
}

fn write_conflict(
    root: &Path,
    run_id: &str,
    phase: &str,
    mismatches: Vec<ByteMismatch>,
) -> Result<PathBuf, LeaseError> {
    let report = ConflictReport {
        version: PROTOCOL_VERSION,
        run_id: run_id.to_string(),
        phase: phase.to_string(),
        mismatches,
        retained: vec![
            format!("{RUNS_DIR}/{run_id}/{JOURNAL_FILE}"),
            format!("{RUNS_DIR}/{run_id}/{OLD_DIR}/"),
            format!("{RUNS_DIR}/{run_id}/{NEW_DIR}/"),
            GENERATED_DIR.to_string(),
        ],
    };
    let text =
        serde_json::to_string_pretty(&report).map_err(|e| io_error("encode conflict", e.into()))?;
    let path = run_dir(root, run_id).join(CONFLICT_FILE);
    persist_file(&path, text.as_bytes())?;
    Ok(path)
}

fn resolve_journal(root: &Path, run_id: &str) -> Result<(), LeaseError> {
    let dir = run_dir(root, run_id);
    fs::rename(dir.join(JOURNAL_FILE), dir.join(RESOLVED_JOURNAL_FILE))
        .map_err(|e| io_error("resolve journal", e))
}

/// Write replacement bytes to a collision-safe temporary sibling of
/// `target` and return its path. The name is unique per attempt and the
/// file is created exclusively, so a stale or saved sibling (including a
/// literal `*.can-new` file) is never overwritten; only the file this call
/// created is ever removed. The caller renames it onto `target`.
fn create_replace_temp(target: &Path, bytes: &[u8]) -> Result<PathBuf, LeaseError> {
    let parent = target.parent().ok_or_else(|| {
        LeaseError::new("invalid-path", "target has no parent directory".to_string())
    })?;
    fs::create_dir_all(parent).map_err(|e| io_error("create target dir", e))?;
    let base = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replacement");
    for _ in 0..10 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = parent.join(format!(
            ".{base}.tmp-{}-{counter}-{nanos}",
            std::process::id()
        ));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error("create replace temp", e)),
        };
        let written = file
            .write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| io_error("write replace temp", e));
        drop(file);
        if let Err(error) = written {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
        return Ok(tmp);
    }
    Err(LeaseError::new(
        "io",
        format!(
            "could not create a unique replace temp for `{}`",
            target.display()
        ),
    ))
}

/// Outcome of [`apply_committed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Every entry reached its new bytes; the journal is resolved.
    Applied {
        /// Entries already at new bytes plus entries replaced now.
        files: usize,
    },
    /// Unexpected bytes stopped the apply; staged payload, current files and
    /// the unresolved journal are retained, with evidence at `conflict_path`.
    Conflict {
        mismatches: Vec<ByteMismatch>,
        conflict_path: PathBuf,
    },
}

/// Apply a committed journal: replace every entry's current file with its
/// staged bytes (atomic per-file rename), copy each scope unit's staged
/// complete old set into `.can/gen/previous/` wholesale, then resolve.
///
/// Entries already at their new hash are skipped, so a second apply after an
/// interruption finishes the set without re-replacing anything: apply is
/// idempotent. Current bytes matching neither old nor new stop the apply with
/// [`ApplyOutcome::Conflict`]; already-replaced entries stay new and the
/// journal stays unresolved until the conflict is reconciled.
fn unexpected_membership(
    root: &Path,
    journal: &RunJournal,
) -> Result<Vec<ByteMismatch>, LeaseError> {
    let mut mismatches = Vec::new();
    if journal.mode != JournalMode::Replace {
        return Ok(mismatches);
    }
    for unit in &journal.scope {
        for path in group_files(root, unit)? {
            if !journal
                .entries
                .iter()
                .any(|e| e.unit == *unit && e.path == path)
            {
                mismatches.push(ByteMismatch {
                    unit: unit.clone(),
                    observed_sha256: current_sha256(&join_rel(&group_dir(root, unit), &path)?)?,
                    path,
                    expected_sha256: None,
                });
            }
        }
    }
    Ok(mismatches)
}

fn remove_empty_parents(path: &Path, stop: &Path) -> Result<(), LeaseError> {
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == stop {
            break;
        }
        match fs::remove_dir(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotADirectory
                ) =>
            {
                break;
            }
            Err(e) => return Err(io_error("remove empty replaced directory", e)),
        }
        current = dir.parent();
    }
    Ok(())
}

enum EntryApply {
    Applied,
    Conflict {
        mismatches: Vec<ByteMismatch>,
        conflict_path: PathBuf,
    },
}

fn retain_previous_groups(root: &Path, dir: &Path, scope: &[String]) -> Result<(), LeaseError> {
    // Retain one previous group per scope unit from the staged complete old
    // set, wholesale, before replacing anything current.
    for unit in scope {
        validate_unit_id(unit)?;
        let previous_unit = root.join(PREVIOUS_DIR).join(unit);
        remove_tree(&previous_unit)?;
        let staged_old = dir.join(OLD_DIR).join(unit);
        if staged_old.exists() {
            copy_tree(&staged_old, &previous_unit)?;
        } else {
            fs::create_dir_all(&previous_unit).map_err(|e| io_error("create previous dir", e))?;
        }
    }
    Ok(())
}

fn apply_journal_entry(
    root: &Path,
    run_id: &str,
    dir: &Path,
    entry: &JournalEntry,
) -> Result<EntryApply, LeaseError> {
    let target = join_rel(&group_dir(root, &entry.unit), &entry.path)?;
    let observed = current_sha256(&target)?;
    if observed == entry.new_sha256 {
        if entry.new_sha256.is_none() {
            remove_empty_parents(&target, &group_dir(root, &entry.unit))?;
        }
        return Ok(EntryApply::Applied);
    }
    if observed != entry.old_sha256 {
        let mismatches = vec![ByteMismatch {
            unit: entry.unit.clone(),
            path: entry.path.clone(),
            expected_sha256: entry.old_sha256.clone(),
            observed_sha256: observed,
        }];
        let conflict_path = write_conflict(root, run_id, "apply", mismatches.clone())?;
        return Ok(EntryApply::Conflict {
            mismatches,
            conflict_path,
        });
    }
    let Some(new_sha256) = &entry.new_sha256 else {
        fs::remove_file(&target).map_err(|e| io_error("delete replaced file", e))?;
        remove_empty_parents(&target, &group_dir(root, &entry.unit))?;
        return Ok(EntryApply::Applied);
    };
    let staged_path = join_rel(dir, entry.staged.as_ref().unwrap())?;
    let staged_bytes = fs::read(&staged_path).map_err(|e| io_error("read staged file", e))?;
    if sha256_of(&staged_bytes) != *new_sha256 {
        return Err(LeaseError::new(
            "io",
            format!(
                "staged payload for `{}` in unit `{}` no longer matches the journal",
                entry.path, entry.unit
            ),
        ));
    }
    // Keep temporary payloads in the ignored run, never in current membership.
    // Rename remains atomic on supported same-filesystem layouts; EXDEV refuses.
    fs::create_dir_all(target.parent().unwrap())
        .map_err(|e| io_error("create replacement parent", e))?;
    let tmp = create_replace_temp(&staged_path, &staged_bytes)?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(io_error("atomic replace", e));
    }
    Ok(EntryApply::Applied)
}

pub fn apply_committed(root: &Path, run_id: &str) -> Result<ApplyOutcome, LeaseError> {
    let journal = read_journal(root, run_id)?;
    if journal.state != JournalState::Committed {
        return Err(LeaseError::new(
            "not-committed",
            format!("run `{run_id}` is staged, not committed; recover it or mark it committed"),
        ));
    }
    let dir = run_dir(root, run_id);
    let extra = unexpected_membership(root, &journal)?;
    if !extra.is_empty() {
        let conflict_path = write_conflict(root, run_id, "apply", extra.clone())?;
        return Ok(ApplyOutcome::Conflict {
            mismatches: extra,
            conflict_path,
        });
    }
    retain_previous_groups(root, &dir, &journal.scope)?;
    let mut files = 0usize;
    // Delete before additions to permit file/directory shape changes.
    for entry in journal
        .entries
        .iter()
        .filter(|e| e.new_sha256.is_none())
        .chain(journal.entries.iter().filter(|e| e.new_sha256.is_some()))
    {
        match apply_journal_entry(root, run_id, &dir, entry)? {
            EntryApply::Applied => files += 1,
            EntryApply::Conflict {
                mismatches,
                conflict_path,
            } => {
                return Ok(ApplyOutcome::Conflict {
                    mismatches,
                    conflict_path,
                });
            }
        }
    }
    resolve_journal(root, run_id)?;
    Ok(ApplyOutcome::Applied { files })
}

/// Outcome of [`commit_journal`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitOutcome {
    /// Flipped to committed and fully applied; the journal is resolved.
    Committed {
        /// Entries now at their new bytes.
        files: usize,
    },
    /// Flipped to committed, then unexpected bytes stopped the apply; the
    /// journal stays unresolved with conflict evidence retained.
    Conflict {
        mismatches: Vec<ByteMismatch>,
        conflict_path: PathBuf,
    },
}

/// Dispatcher hook: flip a staged journal to committed, then apply it.
/// See [`mark_committed`] and [`apply_committed`] for the two interruption
/// boundaries this crosses.
pub fn commit_journal(root: &Path, run_id: &str) -> Result<CommitOutcome, LeaseError> {
    mark_committed(root, run_id)?;
    match apply_committed(root, run_id)? {
        ApplyOutcome::Applied { files } => Ok(CommitOutcome::Committed { files }),
        ApplyOutcome::Conflict {
            mismatches,
            conflict_path,
        } => Ok(CommitOutcome::Conflict {
            mismatches,
            conflict_path,
        }),
    }
}

/// Outcome of [`recover_journal`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryOutcome {
    /// Staged journal: current files all matched the staged old set, so the
    /// whole old group stands; the journal is resolved without writes.
    RestoredOld,
    /// Committed journal: every entry reached its new bytes; resolved.
    CompletedNew {
        /// Entries at new bytes (already-new plus replaced now).
        files: usize,
    },
    /// The journal was already resolved; nothing was touched.
    AlreadyResolved,
    /// Unexpected bytes; nothing destructive ran. Staged payload, current
    /// files and the unresolved journal are retained for reconciliation.
    Conflict {
        mismatches: Vec<ByteMismatch>,
        conflict_path: PathBuf,
    },
}

/// Dispatcher hook: recover one run's journal, idempotently.
///
/// - `staged`: verify every current file still matches its staged old hash
///   (new-file entries must still be absent) and resolve without writing;
///   anything else is a participating edit or foreign write, reported as
///   [`RecoveryOutcome::Conflict`] with current files untouched — recovery
///   never overwrites newer participating work.
/// - `committed`: finish the whole new set exactly like [`apply_committed`].
/// - resolved or never staged: [`RecoveryOutcome::AlreadyResolved`], so a
///   repeated recovery after success is a safe no-op.
pub fn recover_journal(root: &Path, run_id: &str) -> Result<RecoveryOutcome, LeaseError> {
    validate_run_id(run_id)?;
    let dir = run_dir(root, run_id);
    if !dir.join(JOURNAL_FILE).exists() {
        if dir.join(RESOLVED_JOURNAL_FILE).exists() || !dir.exists() {
            return Ok(RecoveryOutcome::AlreadyResolved);
        }
        return Err(LeaseError::new(
            "no-journal",
            format!("run `{run_id}` has no journal file"),
        ));
    }
    let journal = read_journal(root, run_id)?;
    match journal.state {
        JournalState::Committed => match apply_committed(root, run_id)? {
            ApplyOutcome::Applied { files } => Ok(RecoveryOutcome::CompletedNew { files }),
            ApplyOutcome::Conflict {
                mismatches,
                conflict_path,
            } => Ok(RecoveryOutcome::Conflict {
                mismatches,
                conflict_path,
            }),
        },
        JournalState::Staged => {
            let mut mismatches = unexpected_membership(root, &journal)?;
            for entry in &journal.entries {
                let target = join_rel(&group_dir(root, &entry.unit), &entry.path)?;
                let observed = current_sha256(&target)?;
                if observed != entry.old_sha256 {
                    mismatches.push(ByteMismatch {
                        unit: entry.unit.clone(),
                        path: entry.path.clone(),
                        expected_sha256: entry.old_sha256.clone(),
                        observed_sha256: observed,
                    });
                }
            }
            if !mismatches.is_empty() {
                let conflict_path = write_conflict(root, run_id, "recover", mismatches.clone())?;
                return Ok(RecoveryOutcome::Conflict {
                    mismatches,
                    conflict_path,
                });
            }
            resolve_journal(root, run_id)?;
            Ok(RecoveryOutcome::RestoredOld)
        }
    }
}

/// Run ids with an unresolved `journal.json`, in canonical order. Readers
/// refuse to serve any group while this list is non-empty.
pub fn unresolved_journals(root: &Path) -> Vec<String> {
    let mut runs = Vec::new();
    let Ok(entries) = fs::read_dir(root.join(RUNS_DIR)) else {
        return runs;
    };
    for entry in entries.flatten() {
        if entry.path().join(JOURNAL_FILE).is_file() {
            runs.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    runs.sort();
    runs
}

/// One snapshotted build input: exact bytes plus their content hash.
#[derive(Debug, Clone)]
pub struct ConsumedInput {
    /// Root-relative path the bytes were read from.
    pub path: String,
    /// Exact bytes at snapshot time; later edits cannot change this copy.
    pub bytes: Vec<u8>,
    /// SHA-256 over [`ConsumedInput::bytes`].
    pub sha256: String,
}

/// Snapshot consumed build inputs under brief read leases: acquire read
/// leases in canonical order, then refuse when any journal is unresolved
/// (never serve a mixed group), then copy every byte and release. The gate
/// runs while acquired leases cover the consumed closure, so a writer
/// interruption that lands after a pre-acquire check can never surface as
/// mixed bytes. The returned inputs are immutable; the build compiles this
/// snapshot, not live files.
pub fn snapshot_inputs(
    root: &Path,
    holder: &str,
    paths: &[&str],
) -> Result<Vec<ConsumedInput>, LeaseError> {
    let ordered = canonical_order(paths)?;
    let set = acquire(root, paths, LeaseMode::Read, holder)?;
    let unresolved = unresolved_journals(root);
    if !unresolved.is_empty() {
        release(root, &set)?;
        return Err(LeaseError::new(
            "unresolved-journal",
            format!(
                "refusing to read while run journal(s) {} are unresolved",
                unresolved.join(", ")
            ),
        ));
    }
    let mut inputs = Vec::with_capacity(ordered.len());
    for rel in &ordered {
        let full = join_rel(root, rel)?;
        let bytes = match fs::read(&full) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                release(root, &set)?;
                return Err(LeaseError::new(
                    "invalid-path",
                    format!("consumed input `{rel}` does not exist"),
                ));
            }
            Err(e) => {
                release(root, &set)?;
                return Err(io_error("read consumed input", e));
            }
        };
        inputs.push(ConsumedInput {
            path: rel.clone(),
            sha256: sha256_of(&bytes),
            bytes,
        });
    }
    release(root, &set)?;
    Ok(inputs)
}

/// List a scope unit's current group files (unit-relative, canonical order).
/// Build tooling uses this to name the exact files a snapshot must cover.
pub fn group_files(root: &Path, unit: &str) -> Result<Vec<String>, LeaseError> {
    validate_unit_id(unit)?;
    list_files_rel(&group_dir(root, unit))
}
