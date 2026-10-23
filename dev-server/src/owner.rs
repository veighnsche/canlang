//! The native owner loop. Blocking compiler/runtime work returns identified facts
//! to this thread; only this loop mutates SessionState or selects a generation.
mod check_worker;
mod service_worker;

use check_worker::CheckWorker;
use service_worker::ServiceWorker;

use crate::{
    capture::{self, Capture, CaptureRequest, Inventory},
    claim::{ControlError, Result, Selection},
    compiler::{self, CompileResult},
    construct,
    control::{Command, Server},
    examples,
    files::{FileRef, Payloads},
    gateway::{Backend, Gateway},
    inventory,
    model::*,
    preview,
    runtime::{Allocation, Bridge, BridgeConfig},
    sdk, service,
    state::{CheckTicket, Inputs, Refusal, SessionState},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct Config {
    pub selection: Selection,
    pub capture: CaptureRequest,
    pub bridge: BridgeConfig,
    pub mode: CheckMode,
    pub preview_roles: Option<Value>,
}

pub struct Owner {
    pub identity: crate::claim::Identity,
    tx: Sender<Event>,
    thread: Option<thread::JoinHandle<()>>,
    latest: Arc<Mutex<Snapshot>>,
}

impl Owner {
    pub fn start(mut config: Config) -> Result<Self> {
        let (tx, rx) = mpsc::channel();
        let requests = tx.clone();
        let server = Server::start_cancellable(
            config.selection.clone(),
            Arc::new(move |command, cancelled| {
                let (reply, result) = mpsc::channel();
                requests
                    .send(Event::Request(command, reply, cancelled))
                    .map_err(|_| error("CONTROL_CLOSED", "owner closed"))?;
                result
                    .recv_timeout(Duration::from_secs(60))
                    .map_err(|_| error("CONTROL_TIMEOUT", "owner response timed out"))?
            }),
        )?;
        let identity = server.identity.clone();
        config.bridge.session_id = identity.session_id.clone();
        let mut state = SessionState::new(
            identity.session_id.clone(),
            identity.app.clone(),
            config.capture.app_path.clone(),
            config.mode,
        );
        state
            .control_ready()
            .map_err(|_| error("CONTROL_INTERNAL", "owner could not start"))?;
        let events = tx.clone();
        let latest = Arc::new(Mutex::new(state.snapshot()));
        let projection = latest.clone();
        let thread =
            thread::spawn(move || Loop::new(config, state, server, events).run(rx, projection));
        Ok(Self {
            identity,
            tx,
            thread: Some(thread),
            latest,
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        self.latest
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn request(&self, command: Command) -> Result<Value> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Event::Request(
                command,
                tx,
                Arc::new(AtomicBool::new(false)),
            ))
            .map_err(|_| error("CONTROL_CLOSED", "owner closed"))?;
        rx.recv_timeout(Duration::from_secs(60))
            .map_err(|_| error("CONTROL_TIMEOUT", "owner response timed out"))?
    }

    /// Joins only after the owner has confirmed release and retired its claim.
    pub fn join(mut self) -> Result<()> {
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| error("CONTROL_INTERNAL", "owner thread failed"))?;
        }
        Ok(())
    }
}

fn error(code: &str, message: impl Into<String>) -> ControlError {
    ControlError::new(code, message)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

enum Event {
    Request(Command, Sender<Result<Value>>, Arc<AtomicBool>),
    ServiceDone(String, ServiceFact),
    ConstructIndex(String, Arc<ConstructIndex>),
    HostStarting,
    Host(Arc<Bridge>),
    HostReleased,
    Phase(String, CheckPhase, String),
    Captured {
        operation: String,
        capture: Capture,
        hint: u64,
        expected: Option<String>,
        reply: Sender<std::result::Result<CheckTicket, Refusal>>,
    },
    ReuseServing {
        ticket: CheckTicket,
        reply: Sender<bool>,
    },
    Candidate {
        ticket: CheckTicket,
        id: String,
        gateway: Gateway,
        payloads: Payloads,
        reply: Sender<std::result::Result<(), String>>,
    },
    Prepared {
        ticket: CheckTicket,
        id: String,
        backend: Backend,
        capture: Capture,
        hint: u64,
        recipe: Option<Arc<Recipe>>,
    },
    Completed {
        operation: String,
        result: CompileResult,
        capture: Option<Capture>,
    },
    Retain(Capture, CompileResult),
    Superseded(String),
    Retire,
    Dirty,
    Hint(Sender<u64>),
    Failed(String, String),
    Joined,
    Cleanup(
        Vec<(String, std::result::Result<Option<Value>, String>)>,
        bool,
        Option<String>,
    ),
}

struct Generation {
    actors: Value,
    recovery: Option<Value>,
    revision: String,
    gateway: Gateway,
    // Payloads are retained through failed or uncertain runtime cleanup.
    _payloads: Payloads,
}
#[derive(Clone)]
struct RetainedCheck {
    capture: Capture,
    result: CompileResult,
    recipe: Option<Arc<Recipe>>,
}
struct Recipe {
    value: Value,
    actors: Value,
    recovery: Option<Value>,
    _payloads: Payloads,
    reference: FileRef,
    capture: Capture,
    revision: String,
    build: String,
    digest: String,
}
struct ConstructIndex {
    _payloads: Arc<Payloads>,
    reference: FileRef,
    value: Value,
}
struct ServiceJob {
    handle: Option<thread::JoinHandle<()>>,
    cancel: Arc<AtomicBool>,
    sender: Option<Sender<Result<Value>>>,
    command: String,
    revision: Option<String>,
    hint: u64,
}
struct ServiceFact {
    result: Result<Value>,
    current: bool,
    recipe: Option<Arc<Recipe>>,
    run: Option<String>,
    held: Arc<Mutex<Vec<Payloads>>>,
}
struct Loop {
    config: Config,
    state: SessionState,
    server: Server,
    tx: Sender<Event>,
    bridge: Option<Arc<Bridge>>,
    resources: Arc<sdk::Resources>,
    generations: BTreeMap<String, Generation>,
    checks: BTreeMap<String, RetainedCheck>,
    check_order: Vec<String>,
    cancel: Option<Arc<AtomicBool>>,
    waiter: Option<Sender<Result<Value>>>,
    stop_waiters: Vec<Sender<Result<Value>>>,
    jobs: usize,
    cleaning: bool,
    cleanup_requested: bool,
    retire_at: Option<Instant>,
    job: Option<thread::JoinHandle<()>>,
    cleanup_job: Option<thread::JoinHandle<()>>,
    watcher: Option<crate::watch::WatchSet>,
    redactions: Vec<String>,
    service_jobs: BTreeMap<String, ServiceJob>,
    failures: service::Failures,
    recipes: BTreeMap<String, Arc<Recipe>>,
    recipe_order: Vec<String>,
    recovery_at: Instant,
    recovery_warning: bool,
    failure_omitted: u64,
    failure_unavailable: u64,
    indexes: BTreeMap<String, Arc<ConstructIndex>>,
    example_queue: VecDeque<(String, Value, Sender<Result<Value>>, Arc<AtomicBool>)>,
    cleanup_waiters: Vec<Sender<Result<Value>>>,
    recipe_expiry: BTreeMap<String, u64>,
    held_payloads: Vec<Arc<Mutex<Vec<Payloads>>>>,
    held_recipes: Vec<Arc<Recipe>>,
    check_revision: Option<String>,
    build_revision: Option<String>,
    preview_reset: bool,
    failure_waiters: Vec<(String, Value, Sender<Result<Value>>, Arc<AtomicBool>)>,
}

impl Loop {
    fn new(config: Config, state: SessionState, server: Server, tx: Sender<Event>) -> Self {
        let events = tx.clone();
        let mut watcher = crate::watch::WatchSet::new(move || {
            let _ = events.send(Event::Dirty);
        })
        .ok();
        if let Some(watcher) = watcher.as_mut() {
            let _ = watcher.set_inputs(&config.capture, None);
        }
        Self {
            config,
            state,
            server,
            tx,
            bridge: None,
            resources: Arc::default(),
            generations: BTreeMap::new(),
            checks: BTreeMap::new(),
            check_order: vec![],
            cancel: None,
            waiter: None,
            stop_waiters: vec![],
            jobs: 0,
            cleaning: false,
            cleanup_requested: false,
            retire_at: None,
            job: None,
            cleanup_job: None,
            watcher,
            redactions: vec![],
            service_jobs: BTreeMap::new(),
            failures: service::Failures::default(),
            recipes: BTreeMap::new(),
            recipe_order: vec![],
            recovery_at: Instant::now(),
            recovery_warning: false,
            failure_omitted: 0,
            failure_unavailable: 0,
            indexes: BTreeMap::new(),
            example_queue: VecDeque::new(),
            cleanup_waiters: vec![],
            recipe_expiry: BTreeMap::new(),
            held_payloads: vec![],
            held_recipes: vec![],
            check_revision: None,
            build_revision: None,
            preview_reset: false,
            failure_waiters: vec![],
        }
    }
    fn run(mut self, events: Receiver<Event>, latest: Arc<Mutex<Snapshot>>) {
        let interval = Duration::from_millis(100);
        let mut maintenance_at = Instant::now() + interval;
        loop {
            match events.recv_timeout(maintenance_at.saturating_duration_since(Instant::now())) {
                Ok(event) => self.event(event),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
            // Control traffic cannot postpone watcher/host checks or retirement.
            if Instant::now() >= maintenance_at {
                self.poll();
                maintenance_at = Instant::now() + interval;
            }
            if self.jobs == 0 && !self.cleaning && self.cleanup_requested {
                self.cleanup_requested = false;
                self.cleanup();
            }
            *latest.lock().unwrap_or_else(|p| p.into_inner()) = self.state.snapshot();
            if self.state.snapshot().lifecycle == Lifecycle::Stopped && self.retire_at.is_none() {
                break;
            }
        }
    }
    fn event(&mut self, event: Event) {
        match event {
            Event::HostStarting => self.state.host_started(),
            Event::Host(host) => self.bridge = Some(host),
            Event::HostReleased => self.state.host_released(),
            Event::Phase(id, phase, subphase) => {
                self.state.phase(&id, phase, Some(subphase), now())
            }
            Event::Captured {
                operation,
                capture,
                hint,
                expected,
                reply,
            } => {
                let result = self.bind_capture(&operation, &capture, hint, expected.as_deref());
                let _ = reply.send(result);
            }
            Event::ReuseServing { ticket, reply } => {
                let reused = self.reuse_serving(&ticket);
                let _ = reply.send(reused);
            }
            Event::Candidate {
                ticket,
                id,
                gateway,
                payloads,
                reply,
            } => self.candidate(ticket, id, gateway, payloads, reply),
            Event::Prepared {
                ticket,
                id,
                backend,
                capture,
                hint,
                recipe,
            } => self.prepared(ticket, id, backend, capture, hint, recipe),
            Event::Completed {
                operation,
                result,
                capture,
            } => self.completed(&operation, result, capture),
            Event::Retain(capture, result) => self.retain(capture, result),
            Event::Superseded(id) => {
                self.state.dirty();
                self.state.finish(
                    &id,
                    SourceResult::Superseded,
                    PreviewResult::Superseded,
                    Some("captured inputs superseded".into()),
                    now(),
                );
                self.cleanup_requested = true;
                self.respond_check(&id);
            }
            Event::Retire => self.retire(),
            Event::Dirty => self.state.dirty(),
            Event::Hint(reply) => {
                let _ = reply.send(self.state.hint());
            }
            Event::Failed(id, reason) => self.failed(&id, reason),
            Event::Joined => {
                if let Some(job) = self.job.take() {
                    let _ = job.join();
                }
                self.jobs -= 1;
                self.state.job_joined();
                self.cancel = None;
            }
            Event::Cleanup(results, host_released, failure) => {
                if let Some(job) = self.cleanup_job.take() {
                    let _ = job.join();
                    self.state.job_joined();
                }
                self.cleaned(results, host_released, failure);
                self.respond_failure_waiters();
            }
            event => self.policy_event(event),
        }
    }
    fn reuse_serving(&mut self, ticket: &CheckTicket) -> bool {
        self.poll();
        let retained = self.checks.get(&ticket.revision).is_some_and(|check| {
            matches!(&check.result, CompileResult::Artifact { .. })
                && identity(&check.capture) == ticket.inputs
        });
        let cancelled = self
            .cancel
            .as_ref()
            .is_none_or(|cancel| cancel.load(Ordering::Acquire));
        let reused = retained && self.state.reuse_serving(&ticket, cancelled, now());
        if reused {
            self.preview_reset = false;
            self.respond_check(&ticket.operation);
        }
        reused
    }
    fn policy_event(&mut self, event: Event) {
        match event {
            Event::Request(command, sender, cancel) => self.command(command, sender, cancel),
            Event::ServiceDone(id, fact) => self.service_done(&id, fact),
            Event::ConstructIndex(revision, index) => {
                self.indexes.insert(revision, index);
            }
            _ => unreachable!("non-policy event was handled by owner event dispatch"),
        }
    }
    fn command(
        &mut self,
        command: Command,
        sender: Sender<Result<Value>>,
        cancelled: Arc<AtomicBool>,
    ) {
        if let Err(reason) = self.admit(&command.command) {
            let _ = sender.send(Err(reason));
            return;
        }
        let payload = command.payload;
        if matches!(
            command.command.as_str(),
            "failures" | "failure.lookup" | "failure.detail" | "preview.status"
        ) {
            self.refresh_refusals();
        }
        if let Some(result) = self.read_command(&command.command, &payload) {
            let _ = sender.send(result);
            return;
        }
        let result = match command.command.as_str() {
            "check" => {
                self.check(payload, Some(sender), cancelled);
                return;
            }
            "check.request" => {
                let already = self.job.is_some();
                let admitted = self.state.snapshot().admission.check && !already;
                self.check(payload, None, Arc::new(AtomicBool::new(false)));
                Ok(
                    json!({"schema":"can.dev.check-request.v1","accepted":admitted,"alreadyChecking":already}),
                )
            }
            "preview.open" | "construct.help" | "construct.rank" | "example.run"
            | "example.rerun" => {
                self.service_command(command.command, payload, sender, cancelled);
                return;
            }
            "diagnostic.detail"
                if payload["presentationOnly"] == true
                    || self.state.snapshot().lifecycle != Lifecycle::Running
                    || self.bridge.is_none() =>
            {
                self.diagnostic(&payload)
            }
            "diagnostic.detail" => {
                self.service_command(command.command, payload, sender, cancelled);
                return;
            }
            "stop" => {
                let (ignored, _) = mpsc::channel();
                self.stop(ignored);
                Ok(
                    json!({"schema":"can.dev.stop.v1","session":self.server.identity.session_id,"stopping":true}),
                )
            }
            "stop.confirm" => {
                self.stop(sender);
                return;
            }
            "cleanup.retry" => {
                if !self.state.cleanup_required() && !self.cleaning {
                    Ok(json!(self.state.snapshot()))
                } else {
                    self.cleanup_waiters.push(sender);
                    self.cleanup_requested = true;
                    return;
                }
            }
            _ => Err(error("UNKNOWN_COMMAND", "control command is unsupported")),
        };
        let _ = sender.send(result);
    }
    fn read_command(&self, command: &str, payload: &Value) -> Option<Result<Value>> {
        Some(match command {
            "observe" | "observation" => Ok(json!(self.state.snapshot())),
            "help" => Ok(service_help(&self.server.identity.session_id)),
            "status" => Ok(self.status()),
            "preview.status" => Ok(self.preview_status()),
            "rank.lookup" => rank_lookup(payload),
            "diagnostics" => self.diagnostics(payload),
            "failure.lookup" | "failure.detail" => self.failure(command, payload),
            "failures" => self.failure_list(payload),
            "logs" => Ok(self.logs()),
            _ => return None,
        })
    }
    fn status(&self) -> Value {
        let s = self.state.snapshot();
        let last = s.last_outcome.as_ref();
        let capture_error = last
            .filter(|o| o.source == SourceResult::Incomplete)
            .and_then(|o| o.reason.as_deref())
            .map(|r| service::short(r, 300));
        json!({"schema":"can.dev.status.v1","session":s.session,"root":self.server.identity.root,"app":s.app,"profile":self.server.identity.profile,
            "revision":s.revision,"source_revision":s.source_revision,"check_revision":self.check_revision,"build_revision":self.build_revision,
            "serving_revision":s.preview.revision,"serving_build":s.preview.build,
            "stale":s.preview.freshness!=Freshness::Current,"dirty":s.capture!=CaptureState::Confirmed,"preview_reset":self.preview_reset,
            "capture_error":capture_error,"shutdown_error":s.shutdown_error.as_ref().map(|_|"CLEANUP_FAILED"),
            "preview":if s.preview.availability==Availability::Serving{"ready"}else{"unavailable"},"observation":s})
    }
    fn check(
        &mut self,
        payload: Value,
        waiter: Option<Sender<Result<Value>>>,
        cancel: Arc<AtomicBool>,
    ) {
        if payload.get("expectedRevision").is_some_and(|v| {
            v.as_str() != self.state.snapshot().revision.as_deref()
                || self.state.snapshot().capture != CaptureState::Confirmed
        }) {
            if let Some(w) = waiter {
                let _ = w.send(Err(error(
                    "REVISION_CONFLICT",
                    "expected revision is not current",
                )));
            }
            return;
        }
        let id = match self.state.begin_check(now()) {
            Ok(id) => id,
            Err(reason) => {
                if let Some(w) = waiter {
                    let _ = w.send(Err(error("ADMISSION_REFUSED", format!("{reason:?}"))));
                }
                return;
            }
        };
        let expected = payload
            .get("expectedRevision")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.cancel = Some(cancel.clone());
        self.waiter = waiter;
        self.jobs += 1;
        self.state.job_started();
        let worker = CheckWorker {
            resources: self.resources.clone(),
            config: self.config.clone(),
            bridge: self.bridge.clone(),
            tx: self.tx.clone(),
            cancel,
            operation: id.clone(),
            hint: self.state.hint(),
        };
        let events = self.tx.clone();
        self.job = Some(thread::spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.run(expected)));
            if result.is_err() {
                let _ = events.send(Event::Failed(id, "check worker panicked".into()));
            }
            let _ = events.send(Event::Joined);
        }));
    }
    fn bind_capture(
        &mut self,
        operation: &str,
        captured: &Capture,
        hint: u64,
        expected: Option<&str>,
    ) -> std::result::Result<CheckTicket, Refusal> {
        if let Some(watcher) = &mut self.watcher {
            let _ = watcher.set_inputs(&self.config.capture, Some(captured));
        }
        self.state.observe_inputs(identity(captured), hint)?;
        let result = self.state.bind_capture(operation, expected);
        if result == Err(crate::state::Refusal::RevisionConflict) {
            self.state.abandon(operation);
            if let Some(waiter) = self.waiter.take() {
                let _ = waiter.send(Err(error(
                    "REVISION_CONFLICT",
                    "expected revision is not current",
                )));
            }
        }
        result
    }
    fn candidate(
        &mut self,
        ticket: CheckTicket,
        id: String,
        gateway: Gateway,
        payloads: Payloads,
        sender: Sender<std::result::Result<(), String>>,
    ) {
        let result = self
            .state
            .allocate(&ticket, id.clone(), gateway.origin().into())
            .map_err(|e| format!("{e:?}"));
        if result.is_ok() {
            self.generations.insert(
                id,
                Generation {
                    actors: Value::Null,
                    recovery: None,
                    revision: ticket.revision.clone(),
                    gateway,
                    _payloads: payloads,
                },
            );
        } else {
            let mut gateway = gateway;
            gateway.close_admission();
            let _ = gateway.shutdown();
        }
        let _ = sender.send(result);
    }
    fn prepared(
        &mut self,
        ticket: CheckTicket,
        id: String,
        backend: Backend,
        captured: Capture,
        hint: u64,
        recipe: Option<Arc<Recipe>>,
    ) {
        if let Some(recipe) = recipe {
            if let Some(g) = self.generations.get_mut(&id) {
                g.actors = recipe.actors.clone();
                g.recovery = recipe.recovery.clone();
            }
            self.retain_recipe(recipe);
        }
        let result = self.select(&ticket, &id, backend, &captured, hint);
        if let Err(reason) = result {
            self.failed(&ticket.operation, reason);
        } else {
            self.respond_check(&ticket.operation);
        }
        self.cleanup_requested = true;
    }
    fn select(
        &mut self,
        ticket: &CheckTicket,
        id: &str,
        backend: Backend,
        captured: &Capture,
        hint: u64,
    ) -> std::result::Result<(), String> {
        self.state
            .observe_inputs(identity(captured), hint)
            .map_err(|e| format!("{e:?}"))?;
        let generation = self
            .generations
            .get_mut(id)
            .ok_or("candidate unavailable")?;
        if self.redactions.len() < 128 {
            self.redactions.push(backend.secret.clone());
        }
        generation
            .gateway
            .set_observed_backend(
                backend,
                failure_context(
                    &self.server.identity.session_id,
                    &ticket.revision,
                    captured,
                    id,
                ),
                crate::refusals::Catalog::from_capture(captured, &AtomicBool::new(false))?,
            )
            .map_err(|e| e.to_string())?;
        self.state
            .runtime_ready(id, &ticket.operation)
            .map_err(|e| format!("{e:?}"))?;
        self.state
            .phase(&ticket.operation, CheckPhase::Publishing, None, now());
        let replacing = self.state.snapshot().preview.build.is_some();
        self.state
            .publish(ticket, id, now())
            .map_err(|e| format!("{e:?}"))?;
        self.recovery_warning = false;
        self.build_revision = Some(ticket.revision.clone());
        self.preview_reset = replacing;
        Ok(())
    }
    fn completed(&mut self, operation: &str, result: CompileResult, captured: Option<Capture>) {
        let (source, reason) = source_result(&result);
        if let Some(capture) = captured {
            self.retain(capture, result);
        }
        if source == SourceResult::Incomplete {
            self.state.capture_incomplete();
        }
        self.state
            .finish(operation, source, PreviewResult::Unavailable, reason, now());
        self.cleanup_requested = true;
        self.respond_check(operation);
    }
    fn failed(&mut self, operation: &str, reason: String) {
        if reason.starts_with("CLEANUP_REQUIRED:") {
            self.service_cleanup_required();
        }
        let snapshot = self.state.snapshot();
        let stopping = snapshot.lifecycle != Lifecycle::Running;
        let source = match snapshot.operation.as_ref().map(|o| o.phase) {
            Some(CheckPhase::PreparingPreview | CheckPhase::Publishing) => SourceResult::Valid,
            Some(CheckPhase::Capturing) => SourceResult::Incomplete,
            _ => SourceResult::ToolFailure,
        };
        if source == SourceResult::Incomplete {
            self.state.capture_incomplete();
        }
        self.state.finish(
            operation,
            if stopping {
                SourceResult::Cancelled
            } else {
                source
            },
            if !stopping && source == SourceResult::Valid {
                PreviewResult::Failed
            } else {
                PreviewResult::Unavailable
            },
            Some(reason.clone()),
            now(),
        );
        self.cleanup_requested = true;
        if stopping
            || self
                .cancel
                .as_ref()
                .is_some_and(|c| c.load(Ordering::Acquire))
        {
            if let Some(waiter) = self.waiter.take() {
                let _ = waiter.send(Err(error(
                    "REQUEST_CANCELLED",
                    "check request was cancelled",
                )));
            }
        } else {
            self.respond_check(operation);
        }
    }
    fn respond_check(&mut self, _operation: &str) {
        if let Some(waiter) = self.waiter.take() {
            let s = self.state.snapshot();
            let outcome = s.last_outcome.as_ref();
            let revision = outcome.and_then(|o| o.revision.as_deref());
            let retained = revision.and_then(|r| self.checks.get(r));
            let counts = retained
                .map(|c| service::counts(&c.result))
                .unwrap_or((0, 0, 0));
            let analysis = retained.is_some_and(|c| match &c.result {
                CompileResult::Artifact { .. } => true,
                CompileResult::Diagnostics { envelope } => envelope["complete"] == true,
                _ => false,
            });
            let focus = retained
                .zip(revision)
                .map(|(c, r)| service::focus(&s.session, r, &c.capture, &c.result))
                .unwrap_or(Value::Null);
            let preview = match outcome.map(|o| o.preview) {
                Some(PreviewResult::Ready) => "ready",
                Some(PreviewResult::Failed) => "build_failed",
                _ => "unavailable",
            };
            let reason =
                outcome.and_then(|o| check_preview_reason(o.source, o.preview, retained.is_some()));
            let mut value = json!({"schema":"can.dev.check.v1","session":s.session,"revision":revision,"source_revision":retained.map(|c|c.capture.source_revision.clone()).or(s.source_revision),
                "current":revision.is_some_and(|r|self.current(r)),"state":outcome.map(|o|o.source).unwrap_or(SourceResult::Incomplete),
                "evidence":{"capture_complete":retained.is_some(),"analysis_complete":analysis,"diagnostics_reported":counts.0,"diagnostics_omitted":counts.1,"diagnostics_service_omitted":counts.2},
                "focus":focus,"next_diagnostics":revision.filter(|_|counts.0.saturating_sub(counts.2)>1).map(|r|format!("{}/{r}/diagnostics?after=0",s.session)),
                "preview":preview,"preview_reason":reason,"outcome":outcome});
            if preview == "build_failed" {
                value["preview_error"] = json!(
                    outcome
                        .and_then(|o| o.reason.as_deref())
                        .map(|r| service::short(r, 300))
                )
            }
            let _ = waiter.send(Ok(value));
        }
    }
    fn open(&self) -> Result<Value> {
        let s = self.state.snapshot();
        if !s.admission.open {
            return Err(error(
                "PREVIEW_UNAVAILABLE",
                "serving preview is unavailable",
            ));
        }
        let g = s
            .preview
            .build
            .as_ref()
            .and_then(|id| self.generations.get(id))
            .ok_or_else(|| error("PREVIEW_UNAVAILABLE", "serving preview is unavailable"))?;
        let url = g
            .gateway
            .mint_access()
            .map_err(|e| error("PREVIEW_UNAVAILABLE", e.to_string()))?;
        Ok(
            json!({"schema":"can.dev.preview-open.v1","session":s.session,"revision":s.preview.revision,"serving_build":s.preview.build,"url":url}),
        )
    }
    fn stop(&mut self, sender: Sender<Result<Value>>) {
        self.state.stop(now());
        for (_, _, sender, cancel) in self.example_queue.drain(..) {
            cancel.store(true, Ordering::Release);
            let _ = sender.send(Err(error("SESSION_STOPPED", "session is stopping")));
        }
        if let Some(cancel) = &self.cancel {
            cancel.store(true, Ordering::Release);
        }
        for job in self.service_jobs.values() {
            job.cancel.store(true, Ordering::Release);
        }
        for g in self.generations.values() {
            g.gateway.close_admission();
        }
        if let Some(watcher) = &mut self.watcher {
            let _ = watcher.close();
        }
        self.state.access_closed();
        self.cleanup_requested = true;
        if self.stop_waiters.len() >= 32 {
            let _ = sender.send(Err(error(
                "CONTROL_BUSY",
                "stop confirmation already pending",
            )));
        } else {
            self.stop_waiters.push(sender);
        }
    }
    fn cleanup(&mut self) {
        let stopping = self.state.snapshot().lifecycle != Lifecycle::Running;
        let ids = self.state.cleanup_ids();
        let release_host = stopping || self.state.host_cleanup_required();
        if !release_host && ids.is_empty() {
            return;
        }
        self.cleaning = true;
        for id in &ids {
            if let Some(g) = self.generations.get(id) {
                g.gateway.close_admission();
            }
        }
        let contexts: BTreeMap<_, _> = ids
            .iter()
            .filter_map(|id| {
                let generation = self.generations.get(id)?;
                let c = self.checks.get(&generation.revision)?;
                Some((
                    id.clone(),
                    failure_context(
                        &self.server.identity.session_id,
                        &generation.revision,
                        &c.capture,
                        id,
                    ),
                ))
            })
            .collect();
        let bridge = self.bridge.clone();
        let tx = self.tx.clone();
        let resources = self.resources.clone();
        self.state.job_started();
        self.cleanup_job = Some(thread::spawn(move || {
            let mut results = vec![];
            for id in ids {
                results.push((
                    id.clone(),
                    release(bridge.as_deref(), &id, contexts.get(&id).cloned()).and_then(|value| {
                        resources.released(&id)?;
                        Ok(value)
                    }),
                ));
            }
            let host = if release_host {
                bridge
                    .as_ref()
                    .map(|b| {
                        b.shutdown(Instant::now() + Duration::from_secs(5))
                            .map_err(|e| e.to_string())
                    })
                    .unwrap_or(Ok(()))
            } else {
                Ok(())
            };
            let released = release_host && host.is_ok();
            let host = host.and_then(|()| {
                if released {
                    resources.host_released()
                } else {
                    Ok(())
                }
            });
            let _ = tx.send(Event::Cleanup(results, released, host.err()));
        }));
    }
    fn cleaned(
        &mut self,
        results: Vec<(String, std::result::Result<Option<Value>, String>)>,
        host_released: bool,
        failure: Option<String>,
    ) {
        self.cleaning = false;
        let mut failure = failure;
        if host_released {
            self.held_payloads.clear();
            self.held_recipes.clear();
            self.state.host_released();
            self.bridge = None;
        }
        for (id, result) in results {
            if let Ok(Some(refusals)) = &result {
                self.finish_refusals(Ok(refusals.clone()))
            }
            if result.is_err() && !host_released {
                let e = result.unwrap_err();
                let _ = self.state.retire(&id, Some(e.clone()));
                failure = Some(e);
                continue;
            }
            if let Some(g) = self.generations.get_mut(&id) {
                if let Err(e) = g.gateway.shutdown() {
                    failure = Some(e.to_string());
                    continue;
                }
            }
            if let Some(g) = self.generations.get(&id) {
                let batch = g.gateway.drain_refusals();
                self.finish_refusals(Ok(batch));
            }
            self.generations.remove(&id);
            let _ = self.state.released(&id);
        }
        for waiter in self.cleanup_waiters.drain(..) {
            let response = if failure.is_none() {
                Ok(json!(self.state.snapshot()))
            } else {
                Err(error(
                    "CLEANUP_FAILED",
                    "owned runtime release is incomplete; retry this owner",
                ))
            };
            let _ = waiter.send(response);
        }
        if self.state.snapshot().lifecycle == Lifecycle::Running {
            return;
        }
        let released = failure.is_none() && self.state.resources_released();
        if !released {
            self.state.finish_stop(failure.clone());
        }
        for waiter in self.stop_waiters.drain(..) {
            let _ = waiter.send(if released && failure.is_none() { Ok(json!({"schema":"can.dev.stop-confirmed.v1","session":self.server.identity.session_id,"resourcesReleased":true})) }
                else { Err(error("CLEANUP_FAILED", failure.clone().unwrap_or_else(|| "owned resource release is incomplete".into()))) });
        }
        if released {
            self.retire_at = Some(Instant::now());
        }
    }

    fn retire(&mut self) {
        match self.server.retire_when_drained() {
            Ok(true) => {
                self.state.finish_stop(None);
                self.retire_at = None;
            }
            Ok(false) => self.retire_at = Some(Instant::now() + Duration::from_millis(20)),
            Err(_) => {
                self.state.stop(now());
                self.state
                    .finish_stop(Some("control claim retirement failed".into()));
                self.retire_at = None;
            }
        }
    }

    fn poll(&mut self) {
        self.service_maintenance();
        self.recovery_maintenance();
        let mut audit_due = false;
        if let Some(watcher) = &mut self.watcher {
            if watcher.reconcile() {
                self.state.dirty();
            }
            audit_due = watcher.audit_due();
        }
        if audit_due {
            self.audit_inputs();
        }
        if self.retire_at.is_some_and(|t| Instant::now() >= t) {
            self.event(Event::Retire);
        }
        if self.cleaning || self.state.host_cleanup_required() {
            return;
        }
        if let Some(bridge) = &self.bridge {
            if let Err(e) = bridge.check_health() {
                self.state.host_lost(e.to_string());
                for g in self.generations.values() {
                    g.gateway.close_admission();
                }
                if let Some(cancel) = &self.cancel {
                    cancel.store(true, Ordering::Release);
                }
                self.cleanup_requested = true;
            }
            // Allocations were registered before prepare. Late facts keep these
            // handles; they never select a generation or certify whole-tree release.
            for result in bridge.drain_retained() {
                if result
                    .generation_id
                    .as_ref()
                    .is_some_and(|id| self.resources.retired(id))
                {
                    continue;
                }
                if result.allocation == Allocation::ReleaseFailed {
                    self.state
                        .host_lost("runtime operation cleanup remains owned".into());
                    self.cleanup_requested = true;
                }
                if result.generation_id.as_ref().is_some_and(|id| {
                    !self.generations.contains_key(id) && !self.resources.owns(id)
                }) && result.allocation != Allocation::None
                    && result.allocation != Allocation::Released
                {
                    self.state
                        .host_lost("unreconciled runtime allocation".into());
                    self.cleanup_requested = true;
                }
            }
        }
    }
    fn retain(&mut self, capture: Capture, result: CompileResult) {
        let Some(revision) = self.state.snapshot().operation.and_then(|o| o.revision) else {
            return;
        };
        if !self.checks.contains_key(&revision) {
            self.check_order.push(revision.clone());
        }
        let result = service::normalize(&capture, result);
        self.check_revision = Some(revision.clone());
        self.preview_reset = false;
        let recipe = self.checks.get(&revision).and_then(|c| c.recipe.clone());
        self.checks.insert(
            revision,
            RetainedCheck {
                capture,
                result,
                recipe,
            },
        );
        while self.check_order.len() > 32 {
            let old = self.check_order.remove(0);
            self.checks.remove(&old);
            self.indexes.remove(&old);
        }
    }
    fn logs(&self) -> Value {
        match &self.bridge {
            Some(b) => {
                let logs = b.stderr();
                let mut text = logs.text;
                for secret in &self.redactions {
                    text = text.replace(secret, "[redacted]");
                }
                if self.recovery_warning {
                    text.push_str("\nLocal resource recovery failed; retrying.\n");
                }
                json!({"schema":"can.dev.logs.v1","text":text,"dropped_bytes":logs.dropped_bytes})
            }
            None => json!({"schema":"can.dev.logs.v1","unavailable":true}),
        }
    }
    fn diagnostics(&self, payload: &Value) -> Result<Value> {
        let (revision, check) = self.retained(payload)?;
        let items = service::diagnostics(&check.result);
        let (after, limit) = service::page(payload, 10)?;
        let start = usize::try_from(after.saturating_add(1)).unwrap_or(usize::MAX);
        let page: Vec<Value> = items.iter().enumerate().skip(start).take(limit).map(|(i,d)| json!({"ref":format!("{}/{revision}/d{i}",self.server.identity.session_id),"code":d["code"],"severity":d["severity"],"message":service::short(d["message"].as_str().unwrap_or(""),180),"at":service::at(&check.capture,d)})).collect();
        let next = (start.saturating_add(page.len()) < items.len()).then(|| start + page.len() - 1);
        let (reported, compiler_omitted, service_omitted) = service::counts(&check.result);
        Ok(
            json!({"schema":"can.dev.diagnostics.v1","session":self.server.identity.session_id,"revision":revision,"source_revision":check.capture.source_revision,
            "current":self.current(revision),"reported":reported,"compiler_omitted":compiler_omitted,"service_omitted":service_omitted,"diagnostics":page,"next_after":next}),
        )
    }
    fn diagnostic(&self, payload: &Value) -> Result<Value> {
        let (revision, check) = self.retained(payload)?;
        let index = payload["index"]
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
            .ok_or_else(|| error("DIAGNOSTIC_UNAVAILABLE", "diagnostic index is unavailable"))?;
        let d = service::diagnostics(&check.result)
            .get(index)
            .ok_or_else(|| error("DIAGNOSTIC_UNAVAILABLE", "diagnostic index is unavailable"))?;
        Ok(
            json!({"schema":"can.dev.diagnostic.v1","session":self.server.identity.session_id,"revision":revision,"source_revision":check.capture.source_revision,
            "current":self.current(revision),"ref":format!("{}/{revision}/d{index}",self.server.identity.session_id),"source":service::source(&check.capture),"diagnostic":d,
            "captured_excerpt":service::excerpt(&check.capture,d),"construct_help":unknown_help(),"evidence":{"source_excerpt":"unavailable","trace":"unavailable"}}),
        )
    }
    fn retained<'a>(&'a self, payload: &'a Value) -> Result<(&'a str, &'a RetainedCheck)> {
        let revision = service::revision(&payload["revision"])?;
        let check = self
            .checks
            .get(revision)
            .ok_or_else(|| error("REVISION_UNAVAILABLE", "captured revision unavailable"))?;
        Ok((revision, check))
    }
    fn admit(&self, command: &str) -> Result<()> {
        let read = matches!(
            command,
            "help"
                | "status"
                | "observe"
                | "observation"
                | "stop"
                | "stop.confirm"
                | "diagnostics"
                | "diagnostic.detail"
                | "failure.lookup"
                | "failure.detail"
                | "failures"
                | "preview.status"
                | "logs"
        );
        let s = self.state.snapshot();
        if s.lifecycle != Lifecycle::Running && !read {
            return Err(error("SESSION_STOPPING", "session shutdown has begun"));
        }
        if command == "cleanup.retry" || read {
            return Ok(());
        }
        if s.admission.reasons.iter().any(|r| r == "restart_required") {
            return Err(error(
                "RESTART_REQUIRED",
                "owner admission requires restart before new work",
            ));
        }
        if self.state.cleanup_required() {
            return Err(error(
                "CLEANUP_REQUIRED",
                "owner admission requires cleanup before new work",
            ));
        }
        Ok(())
    }
    fn preview_status(&self) -> Value {
        let s = self.state.snapshot();
        json!({"schema":"can.dev.preview.v1","session":s.session,"state":if s.preview.availability==Availability::Serving{"ready"}else{"unavailable"},
            "serving_revision":s.preview.revision,"serving_build":s.preview.build,"stale":s.preview.freshness!=Freshness::Current,
            "failure_focus":self.failures.latest(&json!(s.preview.build)),"preview":s.preview,
            "failures_omitted":self.failure_omitted,"failures_unavailable":self.failure_unavailable})
    }
    fn failure(&self, command: &str, payload: &Value) -> Result<Value> {
        let reference = payload["ref"]
            .as_str()
            .ok_or_else(|| error("INVALID_FAILURE_REF", "failure ref is required"))?;
        let session = &self.server.identity.session_id;
        if !reference.starts_with(&format!("{session}/")) {
            return Err(error(
                "INVALID_FAILURE_REF",
                "failure ref does not select this session",
            ));
        }
        let projection = match self.failures.get(reference) {
            Some(f) => f.projection.clone(),
            None => {
                let parts: Vec<_> = reference.split('/').collect();
                if !compiler_ref_shape(&parts) {
                    return Err(error(
                        "FAILURE_UNAVAILABLE",
                        "captured runtime failure is unavailable",
                    ));
                }
                let digits = parts[2]
                    .strip_prefix('d')
                    .filter(|d| {
                        !d.is_empty()
                            && (*d == "0" || !d.starts_with('0'))
                            && d.bytes().all(|b| b.is_ascii_digit())
                    })
                    .ok_or_else(|| {
                        error(
                            "INVALID_FAILURE_REF",
                            "failure ref does not select this session",
                        )
                    })?;
                let index = digits
                    .parse::<usize>()
                    .map_err(|_| error("INVALID_FAILURE_REF", "failure index is invalid"))?;
                if index as u64 > service::MAX_SAFE_INTEGER {
                    return Err(error("INVALID_FAILURE_REF", "failure index is invalid"));
                }
                let selected = json!({"revision":parts[1]});
                let (r, c) = self.retained(&selected)?;
                service::compiler_failure(session, r, &c.capture, &c.result, index)?
            }
        };
        if command == "failure.lookup" {
            return Ok(projection["occurrence"].clone());
        }
        Ok(
            json!({"schema":"can.dev.failure-detail.v1","ref":projection["occurrence"]["ref"],"revision":projection["occurrence"]["revision"],
            "source_revision":projection["occurrence"]["source_revision"],"detail":projection["detail"]}),
        )
    }
    fn failure_list(&self, payload: &Value) -> Result<Value> {
        let (r, _) = self.retained(payload)?;
        let mut result = self
            .failures
            .list(&self.server.identity.session_id, r, payload)?;
        result["omitted"] = json!(self.failure_omitted);
        result["unavailable"] = json!(self.failure_unavailable);
        Ok(result)
    }
    fn retain_recipe(&mut self, recipe: Arc<Recipe>) {
        for c in self.checks.values_mut() {
            if c.recipe
                .as_ref()
                .is_some_and(|r| !self.recipes.contains_key(&r.build))
            {
                c.recipe = None
            }
        }
        if let Some(c) = self.checks.get_mut(&recipe.revision) {
            c.recipe = Some(recipe)
        }
    }
    fn pin_recipe(&mut self, recipe: Arc<Recipe>) {
        let key = recipe.build.clone();
        if !self.recipes.contains_key(&key) {
            self.recipe_order.push(key.clone());
            self.recipe_expiry.insert(key.clone(), now() + 30 * 60_000);
            self.recipes.insert(key, recipe);
        }
        self.prune_recipes();
    }
    fn prune_recipes(&mut self) {
        let bytes = |recipes: &BTreeMap<String, Arc<Recipe>>| {
            recipes.values().map(|r| r.reference.bytes).sum::<u64>()
        };
        let expired: Vec<_> = self
            .recipe_expiry
            .iter()
            .filter(|(_, expires)| **expires <= now())
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.recipes.remove(&key);
            self.recipe_expiry.remove(&key);
            self.recipe_order.retain(|k| k != &key);
        }
        while self.recipes.len() > 8 || bytes(&self.recipes) > 64 * 1024 * 1024 {
            let old = self.recipe_order.remove(0);
            self.recipes.remove(&old);
            self.recipe_expiry.remove(&old);
        }
        let serving = self.state.snapshot().preview.build;
        for c in self.checks.values_mut() {
            if c.recipe.as_ref().is_some_and(|r| {
                Some(&r.build) != serving.as_ref() && !self.recipes.contains_key(&r.build)
            }) {
                c.recipe = None
            }
        }
    }
    fn service_command(
        &mut self,
        command: String,
        payload: Value,
        sender: Sender<Result<Value>>,
        cancel: Arc<AtomicBool>,
    ) {
        if command.starts_with("example.")
            && self
                .service_jobs
                .values()
                .any(|j| j.command.starts_with("example."))
        {
            if self.example_queue.len() >= 32 {
                let _ = sender.send(Err(error("CONTROL_BUSY", "example request queue is full")));
            } else {
                self.example_queue
                    .push_back((command, payload, sender, cancel));
            }
            return;
        }
        let plan = self.service_plan(&command, &payload);
        let worker = match plan {
            Ok(w) => w,
            Err(e) => {
                let _ = sender.send(Err(e));
                return;
            }
        };
        let id = request_id("service");
        self.spawn_service(id, command, payload, Some(sender), cancel, worker);
    }
    fn service_plan(&mut self, command: &str, payload: &Value) -> Result<ServiceWorker> {
        if self.service_jobs.len() >= 8 {
            return Err(error("CONTROL_BUSY", "owner command limit reached"));
        }
        let snapshot = self.state.snapshot();
        let bridge = self.bridge.clone().ok_or_else(|| {
            error(
                "RUNTIME_UNAVAILABLE",
                "runtime semantic producer is unavailable",
            )
        })?;
        let mut worker = ServiceWorker {
            resources: self.resources.clone(),
            bridge,
            command: command.into(),
            payload: payload.clone(),
            capture: None,
            index: None,
            recipe: None,
            original: None,
            base: Value::Null,
            run: None,
            files: Arc::new(Mutex::new(vec![])),
        };
        match command {
            "preview.open" => {
                worker.base = self.open()?;
                worker.payload["build"] = json!(snapshot.preview.build);
                worker.base["actors"] = snapshot
                    .preview
                    .build
                    .as_ref()
                    .and_then(|b| self.generations.get(b))
                    .map(|r| r.actors.clone())
                    .unwrap_or(Value::Null);
            }
            "example.run" => self.plan_example(&mut worker, payload)?,
            "example.rerun" => self.plan_rerun(&mut worker, payload)?,
            "rank.lookup" => {
                return Err(error(
                    "RANK_UNAVAILABLE",
                    "pending rank does not select this revision",
                ));
            }
            _ => self.plan_construct(&mut worker, payload)?,
        }
        worker.payload["session"] = json!(self.server.identity.session_id);
        Ok(worker)
    }
    fn plan_example(&self, worker: &mut ServiceWorker, payload: &Value) -> Result<()> {
        let revision = payload["expectedRevision"]
            .as_str()
            .filter(|r| service::valid_revision(r))
            .ok_or_else(|| {
                error(
                    "REVISION_REQUIRED",
                    "example run needs the expected revision",
                )
            })?;
        let selected = payload.get("operation").zip(payload.get("rowIndex"));
        if payload.get("operation").is_some() != payload.get("rowIndex").is_some()
            || selected.is_some_and(|(op, row)| {
                op.as_str().is_none_or(|s| s.chars().count() > 200)
                    || service::integer(row).is_none()
            })
        {
            return Err(error(
                "INVALID_REQUEST",
                "selected row needs an operation and nonnegative row index",
            ));
        }
        let s = self.state.snapshot();
        if !self.current(revision) || s.preview.revision.as_deref() != Some(revision) {
            return Err(error(
                "REVISION_CONFLICT",
                "example run requires the current admitted build",
            ));
        }
        if self
            .service_jobs
            .values()
            .any(|j| j.command.starts_with("example."))
        {
            return Err(error(
                "CONTROL_BUSY",
                "an example request is already active",
            ));
        }
        let recipe = self
            .checks
            .get(revision)
            .and_then(|c| c.recipe.as_ref())
            .filter(|r| Some(&r.build) == s.preview.build.as_ref())
            .cloned()
            .ok_or_else(|| {
                error(
                    "EXAMPLES_UNAVAILABLE",
                    "serving build has no verified example recipe",
                )
            })?;
        worker.capture = Some(recipe.capture.clone());
        worker.recipe = Some(recipe);
        worker.run = Some(request_id("run"));
        Ok(())
    }
    fn plan_rerun(&mut self, worker: &mut ServiceWorker, payload: &Value) -> Result<()> {
        let reference = payload["ref"]
            .as_str()
            .filter(|r| r.starts_with(&format!("{}/", self.server.identity.session_id)))
            .ok_or_else(|| {
                error(
                    "INVALID_FAILURE_REF",
                    "failure ref does not select this session",
                )
            })?;
        let f = self
            .failures
            .get(reference)
            .filter(|f| f.rerun.is_some())
            .ok_or_else(|| {
                error(
                    "RERUN_UNAVAILABLE",
                    "retained failure has no supported example row",
                )
            })?;
        worker.original = f.rerun.clone();
        if f.expires <= now() {
            if let Some(original) = &mut worker.original {
                original["expired"] = json!(true)
            }
        }
        worker.recipe = f.recipe.as_ref().and_then(|k| self.recipes.get(k)).cloned();
        worker.capture = worker.recipe.as_ref().map(|r| r.capture.clone());
        worker.run = Some(request_id("run"));
        if self
            .service_jobs
            .values()
            .any(|j| j.command.starts_with("example."))
        {
            return Err(error(
                "CONTROL_BUSY",
                "an example request is already active",
            ));
        }
        Ok(())
    }
    fn plan_construct(&self, worker: &mut ServiceWorker, payload: &Value) -> Result<()> {
        let (revision, c) = self.retained(payload)?;
        let index = self.indexes.get(revision).cloned();
        if worker.command == "diagnostic.detail" {
            worker.base = self.diagnostic(payload)?
        }
        if worker.command == "construct.help" && !valid_construct_id(&payload["id"]) {
            return Err(error(
                "INVALID_REQUEST",
                "construct help needs captured revision and construct ID",
            ));
        }
        if worker.command == "construct.help"
            && index.as_ref().is_some_and(|i| {
                i.value["cards"]
                    .as_array()
                    .is_some_and(|cards| !cards.iter().any(|card| card["id"] == payload["id"]))
            })
        {
            return Err(error(
                "CONSTRUCT_UNKNOWN",
                "construct ID is not in captured help",
            ));
        }
        if worker.command == "construct.rank" {
            validate_rank(payload, &c.result)?
        }
        worker.capture = Some(c.capture.clone());
        worker.index = index;
        worker.payload["current"] = json!(self.rank_current(revision));
        worker.payload["session"] = json!(self.server.identity.session_id);
        if let Some(i) = payload["index"]
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
        {
            worker.payload["diagnostic"] = service::diagnostics(&c.result)
                .get(i)
                .cloned()
                .unwrap_or(Value::Null);
        }
        let counts = service::counts(&c.result);
        worker.payload["complete"] = json!(match &c.result {
            CompileResult::Diagnostics { envelope } => envelope["complete"] == true,
            _ => false,
        });
        worker.payload["omitted"] = json!(counts.1 + counts.2 as u64);
        Ok(())
    }
    fn rank_current(&self, revision: &str) -> bool {
        self.current(revision)
            && self.state.snapshot().lifecycle == Lifecycle::Running
            && self
                .state
                .snapshot()
                .last_outcome
                .as_ref()
                .is_some_and(|o| o.revision.as_deref() == Some(revision))
    }
    fn spawn_service(
        &mut self,
        id: String,
        command: String,
        payload: Value,
        sender: Option<Sender<Result<Value>>>,
        cancel: Arc<AtomicBool>,
        worker: ServiceWorker,
    ) {
        let tx = self.tx.clone();
        let signal = cancel.clone();
        let revision = worker
            .capture
            .as_ref()
            .and_then(|_| payload["revision"].as_str().map(str::to_owned))
            .or_else(|| worker.recipe.as_ref().map(|r| r.revision.clone()));
        self.jobs += 1;
        let worker_id = id.clone();
        let held = worker.files.clone();
        let handle = thread::spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.run(&signal)));
            let fact = result.unwrap_or_else(|_| ServiceFact {
                result: Err(error(
                    "CLEANUP_REQUIRED",
                    "owner command worker panicked; runtime release needs confirmation",
                )),
                current: false,
                recipe: None,
                run: None,
                held,
            });
            let _ = tx.send(Event::ServiceDone(worker_id, fact));
        });
        self.service_jobs.insert(
            id,
            ServiceJob {
                handle: Some(handle),
                cancel,
                sender,
                command,
                revision,
                hint: self.state.hint(),
            },
        );
    }
    fn service_done(&mut self, id: &str, mut fact: ServiceFact) {
        let Some(mut job) = self.service_jobs.remove(id) else {
            return;
        };
        if let Some(handle) = job.handle.take() {
            let _ = handle.join();
        }
        self.jobs -= 1;
        if fact
            .result
            .as_ref()
            .is_err_and(|e| e.code == "CLEANUP_REQUIRED")
        {
            self.held_payloads.push(fact.held.clone());
            if let Some(recipe) = &fact.recipe {
                self.held_recipes.push(recipe.clone())
            }
            self.service_cleanup_required();
        }
        if job.command == "recovery" {
            if !job.cancel.load(Ordering::Acquire) {
                self.recovery_warning = fact.result.is_err();
            }
            return;
        }
        let current = fact.current
            && job.hint == self.state.hint()
            && job.revision.as_ref().is_none_or(|r| self.rank_current(r));
        if !fact.current
            && job.hint == self.state.hint()
            && job.revision.as_ref().is_some_and(|r| self.current(r))
        {
            self.state.dirty()
        }
        if job.command.starts_with("construct.") || job.command == "diagnostic.detail" {
            self.finish_construct(&job, &mut fact, current)
        }
        if job.command.starts_with("example.")
            && !job.cancel.load(Ordering::Acquire)
            && self.state.snapshot().lifecycle == Lifecycle::Running
        {
            self.finish_examples(&job, &mut fact, current)
        }
        if job.cancel.load(Ordering::Acquire) {
            fact.result = Err(error(
                "REQUEST_CANCELLED",
                "owner command request was cancelled",
            ))
        }
        if let Some(sender) = job.sender {
            let _ = sender.send(fact.result);
        }
        self.next_example();
    }
    fn next_example(&mut self) {
        if self
            .service_jobs
            .values()
            .any(|j| j.command.starts_with("example."))
        {
            return;
        }
        while let Some((command, payload, sender, cancel)) = self.example_queue.pop_front() {
            if cancel.load(Ordering::Acquire) {
                let _ = sender.send(Err(error(
                    "REQUEST_CANCELLED",
                    "example request was cancelled",
                )));
                continue;
            }
            self.service_command(command, payload, sender, cancel);
            break;
        }
    }
    fn finish_construct(&mut self, job: &ServiceJob, fact: &mut ServiceFact, current: bool) {
        if let Ok(value) = &mut fact.result {
            if !current {
                if value["card"]["status"] == "working" {
                    value["card"]["status"] = json!("unavailable");
                }
                if let Some(help) = value.get_mut("construct_help") {
                    if let Some(cards) = help["cards"].as_array_mut() {
                        for card in cards.iter_mut() {
                            if card["status"] == "working" {
                                card["status"] = json!("unavailable");
                            }
                        }
                        if !cards.is_empty() {
                            help["candidateCoverage"] = json!("unknown");
                            help["reason"] = json!("source or help revision changed");
                        }
                    }
                }
            }
            if job.command == "construct.rank" && !current {
                value["result"] =
                    json!({"state":"stale","reason":"source or help revision changed"})
            } else if job.command != "construct.rank" {
                value["current"] = json!(current)
            }
        }
    }
    fn finish_examples(&mut self, job: &ServiceJob, fact: &mut ServiceFact, current: bool) {
        let Ok(result) = &mut fact.result else { return };
        let projections = result
            .get("projections")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(object) = result.as_object_mut() {
            object.remove("projections");
        }
        let Some(recipe) = fact.recipe.as_ref() else {
            return;
        };
        let run = fact.run.as_deref().unwrap_or("");
        let report = result.get("private_result").cloned().unwrap_or(Value::Null);
        if let Some(object) = result.as_object_mut() {
            object.remove("private_result");
        }
        self.retain_example_failures(&projections, &report, recipe, run);
        if job.command == "example.run" {
            result["current"] = json!(current);
            result["focus"] = projections
                .get(projections.len().saturating_sub(64))
                .map(|p| p["occurrence"].clone())
                .unwrap_or(Value::Null);
            result["failures_retained"] = json!(projections.len().min(64));
            result["failures_omitted"] = json!(projections.len().saturating_sub(64));
        } else if let Some(p) = projections.first() {
            result["focus"] = p["occurrence"].clone()
        }
    }
    fn retain_example_failures(
        &mut self,
        projections: &[Value],
        result: &Value,
        recipe: &Arc<Recipe>,
        run: &str,
    ) {
        for p in projections {
            if !valid_projection(
                p,
                &self.server.identity.session_id,
                &recipe.revision,
                &recipe.build,
            ) {
                self.failure_unavailable += 1;
                continue;
            }
            let owner = &p["occurrence"]["owner_ref"];
            let rerun = example_rerun_record(result, owner, recipe, run);
            if rerun.is_some() {
                self.pin_recipe(recipe.clone())
            }
            self.failures
                .insert(p.clone(), rerun, Some(recipe.build.clone()), now());
        }
    }
    fn audit_inputs(&mut self) {
        let snapshot = self.state.snapshot();
        if snapshot.lifecycle != Lifecycle::Running
            || snapshot.capture != CaptureState::Confirmed
            || self.service_jobs.values().any(|job| job.command == "audit")
        {
            return;
        }
        let Some(revision) = snapshot.revision else {
            return;
        };
        let payload = json!({"revision":revision});
        match self.service_plan("audit", &payload) {
            Ok(worker) => self.spawn_service(
                request_id("audit"),
                "audit".into(),
                payload,
                None,
                Arc::new(AtomicBool::new(false)),
                worker,
            ),
            // An audit that cannot start cannot certify unchanged inputs.
            Err(_) => self.state.dirty(),
        }
    }
    fn finish_refusals(&mut self, result: Result<Value>) {
        let Ok(value) = result else {
            self.failure_unavailable += 1;
            return;
        };
        self.failure_omitted += value["dropped"].as_u64().unwrap_or(0);
        self.failure_unavailable += value["unavailable"].as_u64().unwrap_or(0);
        for p in value["projections"].as_array().into_iter().flatten() {
            let r = p["occurrence"]["revision"].as_str().unwrap_or("");
            let b = p["occurrence"]["serving_build"].as_str().unwrap_or("");
            if valid_projection(p, &self.server.identity.session_id, r, b) {
                self.failures.insert(p.clone(), None, None, now())
            } else {
                self.failure_unavailable += 1
            }
        }
    }
    fn respond_failure_waiters(&mut self) {
        let waiters = std::mem::take(&mut self.failure_waiters);
        for (command, payload, sender, cancel) in waiters {
            let response = if cancel.load(Ordering::Acquire) {
                Err(error("REQUEST_CANCELLED", "failure request was cancelled"))
            } else {
                self.read_command(&command, &payload).unwrap_or_else(|| {
                    Err(error("UNKNOWN_COMMAND", "control command is unsupported"))
                })
            };
            let _ = sender.send(response);
        }
    }
    fn service_cleanup_required(&mut self) {
        self.state
            .host_lost("runtime operation cleanup remains owned".into());
        self.cleanup_requested = true;
        for generation in self.generations.values() {
            generation.gateway.close_admission();
        }
        if let Some(cancel) = &self.cancel {
            cancel.store(true, Ordering::Release);
        }
        for job in self.service_jobs.values() {
            job.cancel.store(true, Ordering::Release);
        }
    }
    fn recovery_maintenance(&mut self) {
        if self.recovery_at > Instant::now()
            || self.cleaning
            || self.state.host_cleanup_required()
            || self.state.snapshot().lifecycle != Lifecycle::Running
            || self.service_jobs.values().any(|j| j.command == "recovery")
        {
            return;
        }
        self.recovery_at = Instant::now() + Duration::from_secs(1);
        let Some(build) = self.state.snapshot().preview.build else {
            return;
        };
        let Some(recovery) = self
            .generations
            .get(&build)
            .and_then(|r| r.recovery.clone())
        else {
            return;
        };
        let Some(bridge) = self.bridge.clone() else {
            return;
        };
        let payload = json!({"build":build,"recovery":recovery});
        let worker = ServiceWorker {
            resources: self.resources.clone(),
            bridge,
            command: "recovery".into(),
            payload: payload.clone(),
            capture: None,
            index: None,
            recipe: None,
            original: None,
            base: Value::Null,
            run: None,
            files: Arc::new(Mutex::new(vec![])),
        };
        self.spawn_service(
            request_id("recovery"),
            "recovery".into(),
            payload,
            None,
            Arc::new(AtomicBool::new(false)),
            worker,
        );
    }
    fn service_maintenance(&mut self) {
        let mut pending = VecDeque::new();
        for item in self.example_queue.drain(..) {
            if item.3.load(Ordering::Acquire) {
                let _ = item.2.send(Err(error(
                    "REQUEST_CANCELLED",
                    "example request was cancelled",
                )));
            } else {
                pending.push_back(item)
            }
        }
        self.example_queue = pending;
        self.prune_recipes();
        self.refresh_refusals();
    }
    fn refresh_refusals(&mut self) {
        let batches: Vec<_> = self
            .generations
            .values()
            .map(|g| g.gateway.drain_refusals())
            .collect();
        for batch in batches {
            self.finish_refusals(Ok(batch));
        }
    }
    fn current(&self, revision: &str) -> bool {
        let s = self.state.snapshot();
        s.revision.as_deref() == Some(revision) && s.capture == CaptureState::Confirmed
    }
}

fn check_preview_reason(
    source: SourceResult,
    preview: PreviewResult,
    captured: bool,
) -> Option<&'static str> {
    match (source, preview, captured) {
        (_, PreviewResult::Failed, _) => Some("preview_build_failed"),
        (SourceResult::Superseded, _, _) => Some("superseded"),
        (SourceResult::Incomplete, _, false) => Some("capture_incomplete"),
        (SourceResult::Valid, _, _) => None,
        _ => Some("check_not_passed"),
    }
}

fn identity(capture: &Capture) -> Inputs {
    Inputs {
        source_revision: capture.source_revision.clone(),
        digest: capture.epoch_material.clone(),
    }
}

fn unknown_help() -> Value {
    json!({"disposition":"unknown","slot":null,"grammarCoverage":"unknown","candidateCoverage":"unknown","cards":[],"classification":[],"reason":"captured help index is unavailable"})
}
fn rank_lookup(payload: &Value) -> Result<Value> {
    service::revision(&payload["revision"])?;
    if payload
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !matches!(k.as_str(), "revision" | "ref")))
        || payload["ref"].as_str().is_none_or(|r| {
            r.len() != 64
                || !r
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(error("INVALID_REQUEST", "rank lookup needs a pending ref"));
    }
    Err(error(
        "RANK_UNAVAILABLE",
        "pending rank does not select this revision",
    ))
}
fn valid_construct_id(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|v| v.strip_prefix("can.v1."))
        .is_some_and(|v| {
            !v.is_empty()
                && v.len() <= 100
                && v.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
        })
}
fn validate_rank(payload: &Value, result: &CompileResult) -> Result<()> {
    if payload.as_object().is_none_or(|o| {
        o.keys()
            .any(|k| !matches!(k.as_str(), "revision" | "index" | "authorIntent"))
    }) {
        return Err(error(
            "INVALID_REQUEST",
            "ranking needs only a captured revision and diagnostic index or pending ref",
        ));
    }
    let index = service::integer(&payload["index"])
        .and_then(|i| usize::try_from(i).ok())
        .ok_or_else(|| error("INVALID_REQUEST", "ranking needs a diagnostic index"))?;
    if service::diagnostics(result).get(index).is_none() {
        return Err(error(
            "DIAGNOSTIC_UNAVAILABLE",
            "diagnostic index is unavailable",
        ));
    }
    if let Some(intent) = payload.get("authorIntent") {
        if intent.as_str().is_none_or(|s| {
            s.trim().is_empty() || s.encode_utf16().count() > 240 || s.chars().any(char::is_control)
        }) {
            return Err(error(
                "INVALID_REQUEST",
                "author intent needs one sentence of at most 240 characters",
            ));
        }
    }
    Ok(())
}
fn failure_context(session: &str, revision: &str, capture: &Capture, build: &str) -> Value {
    json!({"session":session,"revision":revision,"sourceRevision":capture.source_revision,"sourcePaths":[capture.compiler_operand],"servingBuild":build})
}
fn compiler_ref_shape(parts: &[&str]) -> bool {
    parts.len() == 3
        && service::valid_revision(parts[1])
        && parts[2]
            .strip_prefix('d')
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}
fn valid_projection(p: &Value, session: &str, revision: &str, build: &str) -> bool {
    let o = &p["occurrence"];
    o["schema"] == "can.dev.failure.v1"
        && o["session"] == session
        && o["revision"] == revision
        && o["serving_build"] == build
        && o["ref"]
            .as_str()
            .is_some_and(|r| r.starts_with(&format!("{session}/{revision}/")))
        && p["detail"].is_object()
}
fn example_rerun_record(
    result: &Value,
    owner: &Value,
    recipe: &Recipe,
    run: &str,
) -> Option<Value> {
    if result["report"]["artifact"]["digest"] != recipe.digest
        || result["report"]["artifact"]["sourceRevision"] != recipe.capture.source_revision
        || result["executed"] != result["report"]["summary"]["total"]
    {
        return None;
    }
    let case = owner["case_index"].as_u64()? as usize;
    let entry = owner["entry_index"].as_u64()? as usize;
    let example = result["report"]["cases"].get(case)?;
    let row = example["rows"].get(entry)?;
    if example["kind"] != "table"
        || !matches!(row["outcome"].as_str(), Some("failed" | "setup-failed"))
    {
        return None;
    }
    let selector = json!({"operation":example["operation"],"rowIndex":row["rowIndex"]});
    let matches = result["report"]["cases"]
        .as_array()?
        .iter()
        .filter(|c| c["kind"] == "table" && c["operation"] == selector["operation"])
        .flat_map(|c| c["rows"].as_array().into_iter().flatten())
        .filter(|r| r["rowIndex"] == selector["rowIndex"])
        .count();
    if matches != 1 {
        return None;
    }
    Some(json!({"selector":selector,"original":service::attempt(result,run,row)}))
}
fn load_construct_index(
    bridge: &Bridge,
    capture: &Capture,
    cancel: &AtomicBool,
    events: &Sender<Event>,
) -> Result<ConstructIndex> {
    let _ = (bridge, events);
    let value =
        construct::run(capture, &json!({"action":"index"}), cancel).map_err(native_error)?;
    let mut payloads = Payloads::new().map_err(|e| error("CAPTURE_UNAVAILABLE", e))?;
    let reference = payloads
        .json(&value)
        .map_err(|e| error("CAPTURE_UNAVAILABLE", e))?;
    Ok(ConstructIndex {
        _payloads: Arc::new(payloads),
        reference,
        value,
    })
}
fn retain_runtime_recipe(
    prepared: &preview::Prepared,
    capture: &Capture,
    revision: &str,
    build: &str,
    artifact: &[u8],
) -> std::result::Result<Option<Arc<Recipe>>, String> {
    let mut payloads = Payloads::new()?;
    let reference = payloads.json(&prepared.recipe)?;
    Ok(Some(Arc::new(Recipe {
        value: prepared.recipe.clone(),
        actors: prepared.actors.clone(),
        recovery: prepared.recovery.clone(),
        _payloads: payloads,
        reference,
        capture: capture.clone(),
        revision: revision.into(),
        build: build.into(),
        digest: capture::hash(artifact),
    })))
}
fn native_error(message: String) -> ControlError {
    error(
        if message.contains("CLEANUP_REQUIRED:") {
            "CLEANUP_REQUIRED"
        } else {
            "RUNTIME_REQUEST_FAILED"
        },
        message,
    )
}

fn source_app_matches(source: &str, selected: &str) -> bool {
    source
        .lines()
        .map(str::trim_start)
        .find_map(|line| line.strip_prefix("app ").map(str::trim_start))
        .and_then(|tail| {
            tail.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .next()
        })
        == Some(selected)
}

fn service_help(session: &str) -> Value {
    let commands=[
        ("help",vec![],vec![],"can.dev.help.v1","always"),
        ("status",vec![],vec![],"can.dev.status.v1","always"),
        ("check",vec![],vec![("expectedRevision","revision")],"can.dev.check.v1","always"),
        ("diagnostics",vec![("revision","revision")],vec![("after","integer>=-1"),("limit","integer:1..25")],"can.dev.diagnostics.v1","captured_revision"),
        ("diagnostic.detail",vec![("revision","revision"),("index","integer>=0")],vec![],"can.dev.diagnostic.v1","captured_revision"),
        ("construct.help",vec![("revision","revision"),("id","construct_id")],vec![],"can.dev.construct-help.v1","captured_revision"),
        ("construct.rank",vec![("revision","revision"),("index","integer>=0")],vec![("authorIntent","sentence:1..240")],"can.dev.construct-rank.v1","current_captured_diagnostic"),
        ("rank.lookup",vec![("revision","revision"),("ref","rank_ref")],vec![],"can.dev.construct-rank.v1","current_pending_rank"),
        ("failure.lookup",vec![("ref","failure_ref")],vec![],"can.dev.failure.v1","captured_revision"),
        ("failure.detail",vec![("ref","failure_ref")],vec![],"can.dev.failure-detail.v1","captured_revision"),
        ("failures",vec![("revision","revision")],vec![("after","integer>=-1"),("limit","integer:1..25")],"can.dev.failures.v1","captured_revision"),
        ("preview.status",vec![],vec![],"can.dev.preview.v1","always"),
        ("preview.open",vec![],vec![],"can.dev.preview-open.v1","serving_preview"),
        ("example.run",vec![("expectedRevision","revision")],vec![("operation","operation"),("rowIndex","integer>=0")],"can.dev.example-run.v1","current_verified_artifact"),
        ("example.rerun",vec![("ref","failure_ref")],vec![],"can.dev.example-rerun.v1","retained_failed_row"),
        ("stop",vec![],vec![],"can.dev.stop.v1","always"),
    ].into_iter().map(|(name,required,optional,output,availability)|json!({"name":name,"required":required.into_iter().map(|(name,kind)|json!({"name":name,"type":kind})).collect::<Vec<_>>(),"optional":optional.into_iter().map(|(name,kind)|json!({"name":name,"type":kind})).collect::<Vec<_>>(),"output":output,"availability":availability})).collect::<Vec<_>>();
    json!({"schema":"can.dev.help.v1","protocol":"can.dev.control.v1","session":session,"commands":commands,"unavailable":[]})
}
fn source_result(result: &CompileResult) -> (SourceResult, Option<String>) {
    match result {
        CompileResult::Artifact { .. } => (SourceResult::Valid, None),
        CompileResult::Diagnostics { envelope } => (
            if envelope["complete"] == false {
                SourceResult::Incomplete
            } else if envelope["omitted"].as_u64().is_some_and(|n| n > 0)
                || envelope["diagnostics"]
                    .as_array()
                    .is_some_and(|d| d.len() > service::MAX_DIAGNOSTICS)
            {
                SourceResult::Limited
            } else {
                SourceResult::Errors
            },
            None,
        ),
        CompileResult::ProfileUnsupported { reason } => {
            (SourceResult::Unsupported, Some(reason.clone()))
        }
        CompileResult::CaptureIncomplete { reason } => {
            (SourceResult::Incomplete, Some(reason.clone()))
        }
        CompileResult::ToolFailure { reason } => (SourceResult::ToolFailure, Some(reason.clone())),
        CompileResult::Cancelled { reason } => (SourceResult::Cancelled, Some(reason.clone())),
    }
}
fn release(
    bridge: Option<&Bridge>,
    id: &str,
    context: Option<Value>,
) -> std::result::Result<Option<Value>, String> {
    let Some(bridge) = bridge else {
        return Ok(None);
    };
    let mut payload = json!({});
    if let Some(context) = context {
        payload["context"] = context
    }
    let result = bridge
        .request(
            "release",
            &request_id("release"),
            Some(id),
            payload,
            Instant::now() + Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .map_err(|e| e.to_string())?;
    if !result.ok || result.allocation != Allocation::Released {
        return Err("runtime retained generation cleanup".into());
    }
    Ok(None)
}
fn request_id(prefix: &str) -> String {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    format!("{prefix}-{}", SERIAL.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn check_preview_reasons_keep_capture_source_and_runtime_failures_distinct() {
        assert_eq!(
            check_preview_reason(SourceResult::Incomplete, PreviewResult::Unavailable, false),
            Some("capture_incomplete")
        );
        assert_eq!(
            check_preview_reason(SourceResult::Errors, PreviewResult::Unavailable, true),
            Some("check_not_passed")
        );
        assert_eq!(
            check_preview_reason(SourceResult::Superseded, PreviewResult::Superseded, true),
            Some("superseded")
        );
        assert_eq!(
            check_preview_reason(SourceResult::Valid, PreviewResult::Failed, true),
            Some("preview_build_failed")
        );
        assert_eq!(
            check_preview_reason(SourceResult::Valid, PreviewResult::Ready, true),
            None
        );
    }
    #[test]
    fn pending_rank_lookup_and_foreign_projection_are_not_admitted() {
        assert_eq!(
            rank_lookup(&json!({"revision":"r1","ref":"x"}))
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );
        assert_eq!(
            rank_lookup(&json!({"revision":"r1","ref":"a".repeat(64)}))
                .unwrap_err()
                .code,
            "RANK_UNAVAILABLE"
        );
        let p = json!({"occurrence":{"schema":"can.dev.failure.v1","session":"foreign","revision":"r1","serving_build":"g1","ref":"foreign/r1/request/f0"},"detail":{}});
        assert!(!valid_projection(&p, "ours", "r1", "g1"));
        assert!(source_app_matches("## example\napp Office\n", "Office"));
        assert!(!source_app_matches("app Changed\n", "Office"));
    }
    #[test]
    fn omitted_compiler_diagnostics_are_visible_as_limited() {
        let result = CompileResult::Diagnostics {
            envelope: json!({"complete":true,"omitted":2,"diagnostics":[]}),
        };
        assert_eq!(source_result(&result), (SourceResult::Limited, None));
    }
    #[test]
    fn late_watch_hint_rechecks_exact_bytes_before_binding_without_advancing_epoch() {
        let (_directory, request) = capture::tests::fixture();
        let captured = capture::capture(
            &request,
            &capture::tests::empty_inventory,
            &AtomicBool::new(false),
        )
        .unwrap();
        let (tx, rx) = mpsc::channel();
        let mut state = SessionState::new(
            "test".into(),
            "Office".into(),
            request.app_path.clone(),
            CheckMode::Manual,
        );
        state.control_ready().unwrap();
        let operation = state.begin_check(1).unwrap();
        state.dirty();
        let worker = CheckWorker {
            resources: Arc::default(),
            config: Config {
                selection: Selection {
                    checkout_root: request.checkout_root.clone(),
                    app: "Office".into(),
                    profile: request.profile.clone(),
                    runtime_dir: None,
                },
                bridge: BridgeConfig {
                    node: "node".into(),
                    host_script: "unused".into(),
                    cwd: request.checkout_root.clone().into(),
                    session_id: "test".into(),
                    profile: request.profile.clone(),
                    startup_timeout: Duration::from_secs(1),
                    install_root: None,
                },
                capture: request,
                mode: CheckMode::Manual,
                preview_roles: None,
            },
            bridge: None,
            tx,
            cancel: Arc::new(AtomicBool::new(false)),
            operation,
            hint: 0,
        };
        let job = thread::spawn(move || {
            worker.bind_current(captured, None, &capture::tests::empty_inventory)
        });
        let mut attempts = 0;
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                Event::Captured {
                    operation,
                    capture,
                    hint,
                    expected,
                    reply,
                } => {
                    attempts += 1;
                    state.observe_inputs(identity(&capture), hint).unwrap();
                    let result = state.bind_capture(&operation, expected.as_deref());
                    let accepted = result.is_ok();
                    reply.send(result).unwrap();
                    if accepted {
                        break;
                    }
                }
                Event::Hint(reply) => reply.send(state.hint()).unwrap(),
                Event::Phase(..) => {}
                _ => panic!("unexpected worker fact"),
            }
        }
        let ticket = job.join().unwrap().unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(ticket.revision, "r1");
        assert_eq!(state.snapshot().capture, CaptureState::Confirmed);
    }
}
