//! Filesystem notifications are uncertainty hints. Capture remains the sole
//! authority for source membership, identities and bytes; this module never builds.
use crate::capture::{Capture, CaptureRequest, absolute};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const RECONCILE_INTERVAL: Duration = Duration::from_secs(2);
const AUDIT_INTERVAL: Duration = Duration::from_secs(30);
const MAX_DIRECTORIES: usize = 32_000;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
}
#[derive(Default)]
struct Hints {
    dirty: AtomicBool,
    error: AtomicBool,
    closed: AtomicBool,
    interests: RwLock<Interests>,
}
#[derive(Default)]
struct Interests {
    files: BTreeSet<PathBuf>,
    membership: BTreeSet<PathBuf>,
}
impl Interests {
    fn insert(&mut self, path: PathBuf, membership: bool) {
        self.insert_known(path.clone(), membership);
        if let Ok(actual) = fs::canonicalize(path) {
            self.insert_known(actual, membership);
        }
    }
    fn insert_known(&mut self, path: PathBuf, membership: bool) {
        if membership {
            add_parent(&mut self.membership, &path);
        }
        // Captures already supply requested and canonical names; do not stat
        // every producer again merely to install notification interests.
        self.files.insert(path);
    }
    fn observes(&self, event: &Event) -> bool {
        event.paths.is_empty()
            || event.paths.iter().any(|path| {
                !path.is_absolute()
                    || self
                        .files
                        .iter()
                        .any(|file| path == file || file.starts_with(path))
                    || self
                        .membership
                        .iter()
                        .any(|directory| path.starts_with(directory) || directory.starts_with(path))
            })
    }
}
struct DirectoryPlan {
    identities: BTreeMap<PathBuf, Option<DirectoryIdentity>>,
    targets: BTreeSet<PathBuf>,
}
pub struct WatchSet {
    watcher: Option<RecommendedWatcher>,
    desired: BTreeSet<PathBuf>,
    identities: BTreeMap<PathBuf, Option<DirectoryIdentity>>,
    registrations: BTreeSet<PathBuf>,
    hints: Arc<Hints>,
    sender: Option<SyncSender<()>>,
    callback_thread: Option<JoinHandle<()>>,
    next_reconcile: Instant,
    next_audit: Instant,
}
fn failed(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}
impl WatchSet {
    pub fn new(callback: impl Fn() + Send + 'static) -> io::Result<Self> {
        let hints = Arc::new(Hints::default());
        let (sender, receiver) = mpsc::sync_channel(1);
        let state = hints.clone();
        let callback_thread = thread::Builder::new()
            .name("can-watch-hints".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    if state.closed.load(Ordering::Acquire) {
                        break;
                    }
                    callback();
                }
            })?;
        let watcher = match make_watcher(hints.clone(), sender.clone()) {
            Ok(watcher) => watcher,
            Err(error) => {
                hints.closed.store(true, Ordering::Release);
                drop(sender);
                let _ = callback_thread.join();
                return Err(error);
            }
        };
        let now = Instant::now();
        Ok(Self {
            watcher: Some(watcher),
            desired: BTreeSet::new(),
            identities: BTreeMap::new(),
            registrations: BTreeSet::new(),
            hints,
            sender: Some(sender),
            callback_thread: Some(callback_thread),
            next_reconcile: now + RECONCILE_INTERVAL,
            next_audit: now + AUDIT_INTERVAL,
        })
    }
    /// Watch each requested/canonical input's parent and the root's parent.
    /// Missing parents use their nearest existing ancestor until reconciliation.
    pub fn set_inputs(
        &mut self,
        request: &CaptureRequest,
        capture: Option<&Capture>,
    ) -> io::Result<usize> {
        if self.hints.closed.load(Ordering::Acquire) {
            return Err(failed("watch set is closed"));
        }
        let desired = input_parents(request, capture)?;
        if desired.len() > MAX_DIRECTORIES {
            return Err(failed("watch input directory limit exceeded"));
        }
        *self.hints.interests.write().map_err(failed)? = input_interests(request, capture)?;
        if self.desired == desired && !self.hints.error.load(Ordering::Acquire) {
            return Ok(self.registrations.len());
        }
        self.desired = desired;
        self.rebuild(directory_plan(&self.desired))?;
        self.next_reconcile = Instant::now() + RECONCILE_INTERVAL;
        Ok(self.registrations.len())
    }
    /// Owner calls periodically. A true value means evidence needs recapture,
    /// never that an application compile or publication has been authorized.
    pub fn reconcile(&mut self) -> bool {
        if self.hints.closed.load(Ordering::Acquire) {
            return false;
        }
        let mut uncertain = self.hints.dirty.swap(false, Ordering::AcqRel);
        let now = Instant::now();
        if now < self.next_reconcile {
            return uncertain;
        }
        self.next_reconcile = now + RECONCILE_INTERVAL;
        let plan = directory_plan(&self.desired);
        let changed = plan.identities != self.identities || plan.targets != self.registrations;
        if changed || self.hints.error.load(Ordering::Acquire) {
            uncertain = true;
            let _ = self.rebuild(plan);
            self.signal();
        }
        uncertain
    }
    /// Schedule a byte/membership audit. Elapsed time is not a change hint;
    /// the owner invalidates capture only if that audit cannot confirm it.
    pub fn audit_due(&mut self) -> bool {
        if self.hints.closed.load(Ordering::Acquire) || Instant::now() < self.next_audit {
            return false;
        }
        self.next_audit = Instant::now() + AUDIT_INTERVAL;
        true
    }
    fn signal(&self) {
        self.hints.dirty.store(true, Ordering::Release);
        if let Some(sender) = &self.sender {
            let _ = sender.try_send(());
        }
    }
    fn rebuild(&mut self, plan: DirectoryPlan) -> io::Result<()> {
        // Release the old backend before creating replacement registrations.
        // In notify's supported native backends Drop stops/joins their event loop.
        drop(self.watcher.take());
        self.registrations.clear();
        let sender = self
            .sender
            .as_ref()
            .ok_or_else(|| failed("watch set is closed"))?;
        self.hints.error.store(true, Ordering::Release);
        let mut watcher = make_watcher(self.hints.clone(), sender.clone())?;
        let attached = attach_paths(&mut watcher, &plan.targets);
        self.identities = plan.identities;
        self.watcher = Some(watcher);
        match attached {
            Ok(registrations) => {
                self.registrations = registrations;
                self.hints.error.store(false, Ordering::Release);
                Ok(())
            }
            Err(error) => {
                self.hints.error.store(true, Ordering::Release);
                self.signal();
                Err(error)
            }
        }
    }
    /// Stop native notifications first, then join the only caller of the owner
    /// callback. After this returns no callback can race owner shutdown.
    pub fn close(&mut self) -> io::Result<()> {
        self.hints.closed.store(true, Ordering::Release);
        drop(self.watcher.take());
        self.sender.take();
        self.registrations.clear();
        self.desired.clear();
        self.identities.clear();
        if let Some(thread) = self.callback_thread.take() {
            thread
                .join()
                .map_err(|_| failed("watch callback thread panicked"))?;
        }
        Ok(())
    }
}
impl Drop for WatchSet {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
fn make_watcher(hints: Arc<Hints>, sender: SyncSender<()>) -> io::Result<RecommendedWatcher> {
    notify::recommended_watcher(move |event: notify::Result<Event>| {
        if hints.closed.load(Ordering::Acquire) {
            return;
        }
        match event {
            Ok(event) if matches!(event.kind, EventKind::Access(_)) => return,
            Ok(event)
                if hints
                    .interests
                    .read()
                    .is_ok_and(|inputs| !inputs.observes(&event)) =>
            {
                return;
            }
            Err(_) => {
                hints.error.store(true, Ordering::Release);
            }
            _ => {}
        }
        hints.dirty.store(true, Ordering::Release);
        let _ = sender.try_send(());
    })
    .map_err(failed)
}
fn attach_paths(
    watcher: &mut RecommendedWatcher,
    paths: &BTreeSet<PathBuf>,
) -> io::Result<BTreeSet<PathBuf>> {
    let mut mutation = watcher.paths_mut();
    let mut attached = BTreeSet::new();
    let mut failure = None;
    for path in paths {
        match mutation.add(path, RecursiveMode::NonRecursive) {
            Ok(()) => {
                attached.insert(path.clone());
            }
            Err(error) => {
                failure = Some(failed(error));
                break;
            }
        }
    }
    // Commit even a partial list: the native backend must not remain stopped.
    mutation.commit().map_err(failed)?;
    match failure {
        Some(error) => Err(error),
        None => Ok(attached),
    }
}
// Parent watches also see unrelated siblings (including our own SDK spool trees).
// Match exact tools/source operands, retaining directory membership hints only
// for enumerated producer trees. Capture still verifies every admitted byte.
fn input_interests(request: &CaptureRequest, capture: Option<&Capture>) -> io::Result<Interests> {
    let root = absolute(std::env::current_dir()?, &request.checkout_root);
    let mut interests = Interests::default();
    interests.insert(root.clone(), false);
    for value in [
        &request.app_path,
        &request.compiler_path,
        &request.help_index_path,
    ]
    .into_iter()
    .chain(request.catalog_path.iter())
    {
        interests.insert(absolute(&root, value), false);
    }
    let dynamic = |name: &str| {
        [
            "source:",
            "compiler-source:",
            "runtime-host:",
            "browser:driver:",
            "browser:installation:",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    };
    for input in &request.package_input_paths {
        interests.insert(absolute(&root, &input.path), true);
    }
    for input in &request.extra_input_paths {
        interests.insert(absolute(&root, &input.path), dynamic(&input.name));
    }
    if let Some(capture) = capture {
        for path in [
            &capture.requested_root,
            &capture.root,
            &capture.requested_app_path,
            &capture.app_path,
        ] {
            interests.insert_known(PathBuf::from(path), false);
        }
        for input in &capture.inputs {
            let membership = input.name.starts_with("package:")
                || input.name.strip_prefix("extra:").is_some_and(dynamic);
            for path in [&input.requested_path, &input.canonical_path]
                .into_iter()
                .flatten()
            {
                interests.insert_known(PathBuf::from(path), membership);
            }
        }
        if let Some(closure) = &capture.generated_closure {
            for file in &closure.files {
                interests.insert_known(Path::new(&capture.root).join(&file.path), false);
            }
        }
    }
    Ok(interests)
}
fn input_parents(
    request: &CaptureRequest,
    capture: Option<&Capture>,
) -> io::Result<BTreeSet<PathBuf>> {
    let cwd = std::env::current_dir()?;
    let root = absolute(&cwd, &request.checkout_root);
    let mut parents = BTreeSet::new();
    add_parent(&mut parents, &root);
    for value in [
        &request.app_path,
        &request.compiler_path,
        &request.help_index_path,
    ] {
        add_parent(&mut parents, &absolute(&root, value));
    }
    if let Some(value) = &request.catalog_path {
        add_parent(&mut parents, &absolute(&root, value));
    }
    for input in request
        .package_input_paths
        .iter()
        .chain(&request.extra_input_paths)
    {
        add_parent(&mut parents, &absolute(&root, &input.path));
    }
    if let Some(capture) = capture {
        captured_parents(&mut parents, capture);
    }
    Ok(parents)
}
fn captured_parents(parents: &mut BTreeSet<PathBuf>, capture: &Capture) {
    for value in [
        &capture.requested_root,
        &capture.root,
        &capture.requested_app_path,
        &capture.app_path,
    ] {
        add_parent(parents, Path::new(value));
    }
    for input in &capture.inputs {
        for value in [&input.requested_path, &input.canonical_path]
            .into_iter()
            .flatten()
        {
            add_parent(parents, Path::new(value));
        }
    }
    if let Some(closure) = &capture.generated_closure {
        for file in &closure.files {
            add_parent(parents, &Path::new(&capture.root).join(&file.path));
        }
    }
}
fn add_parent(parents: &mut BTreeSet<PathBuf>, path: &Path) {
    if let Some(parent) = path.parent() {
        parents.insert(parent.to_path_buf());
    }
}
fn directory_identity(path: &Path) -> Option<DirectoryIdentity> {
    let metadata = fs::metadata(path).ok()?;
    metadata.is_dir().then_some(DirectoryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}
fn directory_plan(desired: &BTreeSet<PathBuf>) -> DirectoryPlan {
    let mut identities = BTreeMap::new();
    let mut targets = BTreeSet::new();
    for path in desired {
        let identity = directory_identity(path);
        identities.insert(path.clone(), identity);
        let mut existing = path.as_path();
        loop {
            if let Some(identity) = directory_identity(existing) {
                identities.insert(existing.to_path_buf(), Some(identity));
                targets.insert(existing.to_path_buf());
                break;
            }
            match existing.parent() {
                Some(parent) => existing = parent,
                None => break,
            }
        }
    }
    DirectoryPlan {
        identities,
        targets,
    }
}
