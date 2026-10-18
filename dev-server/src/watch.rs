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
        Arc,
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
    pub fn audit_due(&mut self) -> bool {
        if self.hints.closed.load(Ordering::Acquire) || Instant::now() < self.next_audit {
            return false;
        }
        self.next_audit = Instant::now() + AUDIT_INTERVAL;
        self.signal();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, mpsc};
    fn request(root: &Path) -> CaptureRequest {
        serde_json::from_value(serde_json::json!({ "checkoutRoot": root, "appPath": "app/app.can", "profile": "local-d1-identity",
            "compilerPath": "tools/can", "catalogPath": null, "helpIndexPath": "help.md", "packageInputPaths": [], "extraInputPaths": [] })).unwrap()
    }
    fn force_reconcile(watcher: &mut WatchSet) -> bool {
        watcher.next_reconcile = Instant::now();
        watcher.reconcile()
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
        assert!(force_reconcile(&mut watcher));
        fs::create_dir(root.path().join("app")).unwrap();
        fs::write(root.path().join("app/app.can"), "recovered").unwrap();
        assert!(force_reconcile(&mut watcher));
        while rx.try_recv().is_ok() {}
        fs::write(root.path().join("app/app.can"), "after-recovery").unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        watcher.next_audit = Instant::now();
        assert!(watcher.audit_due());
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
    fn includes_requested_and_canonical_parent_names_and_reattaches_after_backend_error() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("app")).unwrap();
        let mut input = request(root.path());
        input
            .package_input_paths
            .push(crate::capture::NamedInputPath {
                name: "installed".into(),
                path: "dist/index.js".into(),
            });
        let capture: Capture = serde_json::from_value(serde_json::json!({
            "requestedRoot": root.path(), "root": root.path(), "requestedAppPath": root.path().join("app/app.can"),
            "appPath": root.path().join("real/app.can"), "compilerOperand": "app/app.can", "sourceText": "", "sourceSha256": "x",
            "sourceBytes": 0, "sourceRevision": "r", "epochMaterial": "e", "profile": "local-d1-identity", "semanticOptions": {},
            "inputs": [{ "name": "installed", "requestedPath": root.path().join("dist/index.js"), "canonicalPath": root.path().join("real-dist/index.js"),
                "sha256": null, "bytes": null, "state": "missing" }] })).unwrap();
        let parents = input_parents(&input, Some(&capture)).unwrap();
        assert!(parents.contains(&root.path().join("dist")));
        assert!(parents.contains(&root.path().join("real-dist")));
        let mut watcher = WatchSet::new(|| {}).unwrap();
        watcher.set_inputs(&input, Some(&capture)).unwrap();
        watcher.hints.error.store(true, Ordering::Release);
        assert!(force_reconcile(&mut watcher));
        assert!(!watcher.hints.error.load(Ordering::Acquire));
        watcher.close().unwrap();
    }
    #[test]
    fn detects_replaced_fallback_ancestor_while_desired_directory_stays_missing() {
        let root = tempfile::tempdir().unwrap();
        let fallback = root.path().join("outside");
        fs::create_dir(&fallback).unwrap();
        let desired = BTreeSet::from([fallback.join("missing/child")]);
        let before = directory_plan(&desired);
        assert!(before.targets.contains(&fallback));
        assert_eq!(
            before.identities[&desired.iter().next().unwrap().clone()],
            None
        );
        assert!(before.identities[&fallback].is_some());
        fs::rename(&fallback, root.path().join("retired")).unwrap();
        fs::create_dir(&fallback).unwrap();
        let after = directory_plan(&desired);
        assert_eq!(before.targets, after.targets);
        assert_ne!(before.identities, after.identities);
        let mut watcher = WatchSet::new(|| {}).unwrap();
        watcher.desired = desired;
        watcher.rebuild(before).unwrap();
        assert!(force_reconcile(&mut watcher));
        assert_eq!(watcher.identities, after.identities);
        watcher.close().unwrap();
    }
}
