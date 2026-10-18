//! The native owner loop. Blocking compiler/runtime work returns identified facts
//! to this thread; only this loop mutates SessionState or selects a generation.
use crate::{
    capture::{self, Capture, CaptureRequest, Inventory},
    claim::{ControlError, Result, Selection},
    compiler::{self, CompileResult},
    control::{Command, Server},
    files::{self, FileRef, Payloads},
    gateway::{Backend, Gateway},
    model::*,
    runtime::{Allocation, Bridge, BridgeConfig, Reply},
    state::{CheckTicket, Inputs, Refusal, SessionState},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
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
        let server = Server::start(
            config.selection.clone(),
            Arc::new(move |command| {
                let (reply, result) = mpsc::channel();
                requests
                    .send(Event::Request(command, reply))
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
            .send(Event::Request(command, tx))
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
fn reply(result: &Reply) -> std::result::Result<Value, String> {
    if result.ok {
        Ok(result.result.clone().unwrap_or(Value::Null))
    } else {
        Err(result
            .error
            .as_ref()
            .map(|e| format!("{}: {}", e.code, e.message))
            .unwrap_or_else(|| "runtime request failed".into()))
    }
}
fn ready_backend(response: &Reply, id: &str, origin: &str) -> std::result::Result<Backend, String> {
    let result = reply(response)?;
    if result["id"] != id
        || result["origin"] != origin
        || result["readiness"] != true
        || response.allocation != Allocation::Owned
    {
        return Err("runtime readiness identity mismatch".into());
    }
    serde_json::from_value(result["backend"].clone()).map_err(|e| e.to_string())
}

enum Event {
    Request(Command, Sender<Result<Value>>),
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
        Vec<(String, std::result::Result<(), String>)>,
        bool,
        Option<String>,
    ),
}

struct Generation {
    gateway: Gateway,
    // Payloads are retained through failed or uncertain runtime cleanup.
    _payloads: Payloads,
}
struct RetainedCheck {
    capture: Capture,
    result: CompileResult,
}
struct Loop {
    config: Config,
    state: SessionState,
    server: Server,
    tx: Sender<Event>,
    bridge: Option<Arc<Bridge>>,
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
            Event::Request(command, sender) => self.command(command, sender),
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
            } => self.prepared(ticket, id, backend, capture, hint),
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
                self.cleaned(results, host_released, failure)
            }
        }
    }
    fn command(&mut self, command: Command, sender: Sender<Result<Value>>) {
        let payload = command.payload;
        let result = match command.command.as_str() {
            "observe" | "observation" => Ok(json!(self.state.snapshot())),
            "status" => Ok(self.status()),
            "check" => {
                self.check(payload, Some(sender));
                return;
            }
            "check.request" => {
                let already = self.jobs > 0;
                let admitted = self.state.snapshot().admission.check;
                self.check(payload, None);
                Ok(
                    json!({"schema":"can.dev.check-request.v1","accepted":admitted,"alreadyChecking":already}),
                )
            }
            "preview.status" => Ok(
                json!({"schema":"can.dev.preview-status.v1","session":self.server.identity.session_id,"preview":self.state.snapshot().preview}),
            ),
            "preview.open" => self.open(),
            "diagnostics" => self.diagnostics(&payload),
            "diagnostic.detail" => self.diagnostic(&payload),
            "stop.confirm" | "stop" => {
                self.stop(sender);
                return;
            }
            "cleanup.retry" => {
                self.cleanup_requested = true;
                Ok(json!({"schema":"can.dev.cleanup-request.v1","accepted":true}))
            }
            "logs" => Ok(self.logs()),
            _ => Err(error(
                "COMMAND_UNAVAILABLE",
                "command has not completed Rust parity; the installed TypeScript entry is still authoritative",
            )),
        };
        let _ = sender.send(result);
    }
    fn status(&self) -> Value {
        let s = self.state.snapshot();
        json!({"schema":"can.dev.status.v1","session":s.session,"root":self.server.identity.root,"app":s.app,"profile":self.server.identity.profile,
            "revision":s.revision,"source_revision":s.source_revision,"serving_revision":s.preview.revision,"serving_build":s.preview.build,
            "stale":s.preview.freshness!=Freshness::Current,"dirty":s.capture!=CaptureState::Confirmed,"observation":s})
    }
    fn check(&mut self, payload: Value, waiter: Option<Sender<Result<Value>>>) {
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
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel = Some(cancel.clone());
        self.waiter = waiter;
        self.jobs += 1;
        self.state.job_started();
        let worker = CheckWorker {
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
    ) {
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
            .set_backend(backend)
            .map_err(|e| e.to_string())?;
        self.state
            .runtime_ready(id, &ticket.operation)
            .map_err(|e| format!("{e:?}"))?;
        self.state
            .phase(&ticket.operation, CheckPhase::Publishing, None, now());
        self.state
            .publish(ticket, id, now())
            .map_err(|e| format!("{e:?}"))?;
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
            PreviewResult::Failed,
            Some(reason.clone()),
            now(),
        );
        self.cleanup_requested = true;
        if let Some(waiter) = self.waiter.take() {
            let _ = waiter.send(Err(error("CHECK_FAILED", reason)));
        }
    }
    fn respond_check(&mut self, _operation: &str) {
        if let Some(waiter) = self.waiter.take() {
            let s = self.state.snapshot();
            let _ = waiter.send(Ok(json!({"schema":"can.dev.check.v1","session":s.session,"revision":s.last_outcome.as_ref().and_then(|o|o.revision.clone()),
                "source_revision":s.source_revision,"current":s.capture==CaptureState::Confirmed && s.last_outcome.as_ref().and_then(|o|o.revision.as_ref())==s.revision.as_ref(),"outcome":s.last_outcome,"preview":s.preview})));
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
            json!({"schema":"can.dev.preview-access.v1","session":s.session,"revision":s.preview.revision,"serving_build":s.preview.build,"url":url}),
        )
    }
    fn stop(&mut self, sender: Sender<Result<Value>>) {
        self.state.stop(now());
        if let Some(cancel) = &self.cancel {
            cancel.store(true, Ordering::Release);
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
        let bridge = self.bridge.clone();
        let tx = self.tx.clone();
        self.state.job_started();
        self.cleanup_job = Some(thread::spawn(move || {
            let mut results = vec![];
            for id in ids {
                results.push((id.clone(), release(bridge.as_deref(), &id)));
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
            let _ = tx.send(Event::Cleanup(results, released, host.err()));
        }));
    }
    fn cleaned(
        &mut self,
        results: Vec<(String, std::result::Result<(), String>)>,
        host_released: bool,
        failure: Option<String>,
    ) {
        self.cleaning = false;
        let mut failure = failure;
        if host_released {
            self.state.host_released();
            self.bridge = None;
        }
        for (id, result) in results {
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
            self.generations.remove(&id);
            let _ = self.state.released(&id);
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
        if let Some(watcher) = &mut self.watcher {
            if watcher.reconcile() || watcher.audit_due() {
                self.state.dirty();
            }
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
                    .is_some_and(|id| !self.generations.contains_key(id))
                    && result.allocation != Allocation::None
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
        self.checks
            .insert(revision, RetainedCheck { capture, result });
        while self.check_order.len() > 32 {
            self.checks.remove(&self.check_order.remove(0));
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
                json!({"schema":"can.dev.logs.v1","text":text,"dropped_bytes":logs.dropped_bytes})
            }
            None => json!({"schema":"can.dev.logs.v1","unavailable":true}),
        }
    }
    fn diagnostics(&self, payload: &Value) -> Result<Value> {
        let (revision, check) = self.retained(payload)?;
        let items = diagnostic_items(&check.result);
        let after = payload.get("after").and_then(Value::as_i64).unwrap_or(-1);
        let limit = payload.get("limit").and_then(Value::as_u64).unwrap_or(10);
        if after < -1 || limit == 0 || limit > 25 {
            return Err(error(
                "INVALID_REQUEST",
                "diagnostic cursor or limit is invalid",
            ));
        }
        let start = usize::try_from(after + 1).unwrap_or(usize::MAX);
        let page: Vec<Value> = items.iter().enumerate().skip(start).take(limit as usize).map(|(i,d)| json!({"ref":format!("{}/{revision}/d{i}",self.server.identity.session_id),"code":d["code"],"severity":d["severity"],"message":d["message"],"at":d["primary"]})).collect();
        let next =
            (start.saturating_add(page.len()) < items.len()).then_some(start + page.len() - 1);
        Ok(
            json!({"schema":"can.dev.diagnostics.v1","session":self.server.identity.session_id,"revision":revision,"source_revision":check.capture.source_revision,
            "current":self.current(revision),"diagnostics":page,"next_after":next}),
        )
    }
    fn diagnostic(&self, payload: &Value) -> Result<Value> {
        let (revision, check) = self.retained(payload)?;
        let index = payload
            .get("index")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("INVALID_REQUEST", "diagnostic index required"))?
            as usize;
        let d = diagnostic_items(&check.result)
            .get(index)
            .ok_or_else(|| error("DIAGNOSTIC_UNAVAILABLE", "diagnostic index unavailable"))?;
        Ok(
            json!({"schema":"can.dev.diagnostic.v1","session":self.server.identity.session_id,"revision":revision,"source_revision":check.capture.source_revision,
            "current":self.current(revision),"ref":format!("{}/{revision}/d{index}",self.server.identity.session_id),"diagnostic":d,
            "captured_excerpt":excerpt(&check.capture,d),"evidence":{"source_excerpt":"unavailable","trace":"unavailable"}}),
        )
    }
    fn retained<'a>(&'a self, payload: &'a Value) -> Result<(&'a str, &'a RetainedCheck)> {
        let revision = payload
            .get("revision")
            .and_then(Value::as_str)
            .ok_or_else(|| error("INVALID_REQUEST", "captured revision required"))?;
        Ok((
            revision,
            self.checks
                .get(revision)
                .ok_or_else(|| error("REVISION_UNAVAILABLE", "captured revision unavailable"))?,
        ))
    }
    fn current(&self, revision: &str) -> bool {
        let s = self.state.snapshot();
        s.revision.as_deref() == Some(revision) && s.capture == CaptureState::Confirmed
    }
}

fn identity(capture: &Capture) -> Inputs {
    Inputs {
        source_revision: capture.source_revision.clone(),
        digest: capture.epoch_material.clone(),
    }
}
fn diagnostic_items(result: &CompileResult) -> &[Value] {
    match result {
        CompileResult::Diagnostics { envelope } => envelope["diagnostics"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        _ => &[],
    }
}
fn excerpt(capture: &Capture, diagnostic: &Value) -> Value {
    if diagnostic["primary"]["file"] != 0 {
        return Value::Null;
    }
    let start = diagnostic["primary"]["start"].as_u64().unwrap_or(0) as usize;
    let end = diagnostic["primary"]["end"].as_u64().unwrap_or(0) as usize;
    let bytes = capture.source_text.as_bytes();
    let start = start.saturating_sub(160).min(bytes.len());
    let end = end
        .saturating_add(160)
        .min(bytes.len())
        .min(start + 800)
        .max(start);
    json!({"text":String::from_utf8_lossy(&bytes[start..end]),"start":start,"end":end})
}
fn source_result(result: &CompileResult) -> (SourceResult, Option<String>) {
    match result {
        CompileResult::Artifact { .. } => (SourceResult::Valid, None),
        CompileResult::Diagnostics { envelope } => (
            if envelope["complete"] == false {
                SourceResult::Incomplete
            } else if envelope["omitted"].as_u64().is_some_and(|n| n > 0) {
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
fn release(bridge: Option<&Bridge>, id: &str) -> std::result::Result<(), String> {
    let Some(bridge) = bridge else {
        return Ok(());
    };
    let result = bridge
        .request(
            "release",
            &request_id("release"),
            Some(id),
            json!({}),
            Instant::now() + Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .map_err(|e| e.to_string())?;
    if result.ok && result.allocation == Allocation::Released {
        Ok(())
    } else {
        Err("runtime retained generation cleanup".into())
    }
}
fn request_id(prefix: &str) -> String {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    format!("{prefix}-{}", SERIAL.fetch_add(1, Ordering::Relaxed))
}

struct CheckWorker {
    config: Config,
    bridge: Option<Arc<Bridge>>,
    tx: Sender<Event>,
    cancel: Arc<AtomicBool>,
    operation: String,
    hint: u64,
}
impl CheckWorker {
    fn run(mut self, expected: Option<String>) {
        let result = self.perform(expected);
        if let Err(reason) = result {
            let _ = self.tx.send(Event::Failed(self.operation.clone(), reason));
        }
    }
    fn perform(&mut self, expected: Option<String>) -> std::result::Result<(), String> {
        let bridge = self.host()?;
        let inventory = || self.inventory(&bridge, CheckPhase::Capturing);
        let mut request = self.config.capture.clone();
        if request.input_inventory.as_deref() == Some("installed-local-preview") {
            let inputs = inventory()?;
            request.package_input_paths = inputs.package_input_paths;
            request.extra_input_paths = inputs.extra_input_paths;
        }
        let capture = capture::capture_with_phases(&request, &inventory, &self.cancel, &|phase| {
            self.phase(CheckPhase::Capturing, phase)
        })?;
        let ticket = self.bind_current(capture.clone(), expected, &inventory)?;
        let compiler_inventory = || self.inventory(&bridge, CheckPhase::CheckingSource);
        self.phase(CheckPhase::CheckingSource, "compiler");
        let result = compiler::compile(&capture, &compiler_inventory, &self.cancel, &|phase| {
            self.phase(CheckPhase::CheckingSource, phase)
        });
        match result {
            CompileResult::Artifact {
                artifact,
                artifact_bytes,
            } => self.prepare(&bridge, ticket, capture, artifact, artifact_bytes, &|| {
                self.inventory(&bridge, CheckPhase::PreparingPreview)
            }),
            result => {
                self.tx
                    .send(Event::Completed {
                        operation: self.operation.clone(),
                        result,
                        capture: Some(capture),
                    })
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
        }
    }
    fn host(&mut self) -> std::result::Result<Arc<Bridge>, String> {
        if let Some(host) = &self.bridge {
            return Ok(host.clone());
        }
        self.phase(CheckPhase::Capturing, "starting_runtime_host");
        self.tx
            .send(Event::HostStarting)
            .map_err(|e| e.to_string())?;
        let result = Bridge::spawn(self.config.bridge.clone());
        let host = match result {
            Ok(host) => Arc::new(host),
            Err(mut error) => {
                if let Some(host) = error.retained.take() {
                    let _ = self.tx.send(Event::Host(Arc::new(*host)));
                } else {
                    let _ = self.tx.send(Event::HostReleased);
                }
                return Err(error.to_string());
            }
        };
        self.tx
            .send(Event::Host(host.clone()))
            .map_err(|e| e.to_string())?;
        self.bridge = Some(host.clone());
        Ok(host)
    }
    fn inventory(
        &self,
        bridge: &Bridge,
        phase: CheckPhase,
    ) -> std::result::Result<Inventory, String> {
        self.phase(phase, "enumerating_input_membership");
        let response=bridge.request("inventory",&request_id("inventory"),None,json!({"root":self.config.capture.checkout_root,"compilerPath":self.config.capture.compiler_path,"catalogPath":self.config.capture.catalog_path}),Instant::now()+Duration::from_secs(15),&self.cancel).map_err(|e|e.to_string())?;
        let value = reply(&response)?;
        let reference: FileRef =
            serde_json::from_value(value["inventory"].clone()).map_err(|e| e.to_string())?;
        let inventory =
            serde_json::from_slice(&files::read(&reference)?).map_err(|e| e.to_string())?;
        self.phase(phase, "verifying_captured_bytes");
        Ok(inventory)
    }
    fn bind(
        &self,
        capture: Capture,
        expected: Option<String>,
        hint: u64,
    ) -> std::result::Result<std::result::Result<CheckTicket, Refusal>, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Event::Captured {
                operation: self.operation.clone(),
                capture,
                hint,
                expected,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())
    }
    fn current_hint(&self) -> std::result::Result<u64, String> {
        let (tx, rx) = mpsc::channel();
        self.tx.send(Event::Hint(tx)).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())
    }
    fn bind_current(
        &self,
        captured: Capture,
        expected: Option<String>,
        inventory: &capture::InventoryProvider<'_>,
    ) -> std::result::Result<CheckTicket, String> {
        let first = self.bind(captured.clone(), expected.clone(), self.hint)?;
        if first != Err(Refusal::CaptureUnconfirmed) {
            return first.map_err(|e| format!("{e:?}"));
        }
        // A watch hint can arrive after its bytes were already read. Confirm
        // against a fresh hint serial instead of treating that hint as failure.
        let hint = self.current_hint()?;
        if !capture::is_current_with_phases(&captured, inventory, &self.cancel, &|phase| {
            self.phase(CheckPhase::Capturing, phase)
        }) {
            return Err("captured inputs changed while confirming a watch hint".into());
        }
        self.bind(captured, expected, hint)?
            .map_err(|e| format!("{e:?}"))
    }
    fn phase(&self, phase: CheckPhase, subphase: &str) {
        let _ = self
            .tx
            .send(Event::Phase(self.operation.clone(), phase, subphase.into()));
    }
    fn prepare(
        &self,
        bridge: &Bridge,
        ticket: CheckTicket,
        captured: Capture,
        artifact: Value,
        bytes: Vec<u8>,
        inventory: &capture::InventoryProvider<'_>,
    ) -> std::result::Result<(), String> {
        self.tx
            .send(Event::Retain(
                captured.clone(),
                CompileResult::Artifact {
                    artifact,
                    artifact_bytes: bytes.clone(),
                },
            ))
            .map_err(|e| e.to_string())?;
        self.phase(CheckPhase::PreparingPreview, "preparing_runtime");
        let gateway = Gateway::bind().map_err(|e| e.to_string())?;
        let origin = gateway.origin().to_owned();
        let id = request_id("generation");
        let mut payloads = Payloads::new()?;
        let artifact_ref = payloads.write(&bytes)?;
        let capture_ref = payloads.json(&captured)?;
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Event::Candidate {
                ticket: ticket.clone(),
                id: id.clone(),
                gateway,
                payloads,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())??;
        let mut payload = json!({"origin":origin,"artifact":artifact_ref,"capture":capture_ref});
        if let Some(roles) = &self.config.preview_roles {
            payload["previewRoles"] = roles.clone();
        }
        let response = bridge
            .request(
                "prepare",
                &self.operation,
                Some(&id),
                payload,
                Instant::now() + Duration::from_secs(60),
                &self.cancel,
            )
            .map_err(|e| e.to_string())?;
        let backend = ready_backend(&response, &id, &origin)?;
        self.phase(CheckPhase::PreparingPreview, "verifying_publication_inputs");
        let hint = self.current_hint()?;
        if !capture::is_current_with_phases(&captured, inventory, &self.cancel, &|phase| {
            self.phase(CheckPhase::PreparingPreview, phase)
        }) {
            self.tx
                .send(Event::Superseded(self.operation.clone()))
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        self.tx
            .send(Event::Prepared {
                ticket,
                id,
                backend,
                capture: captured,
                hint,
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
