//! Private bounded NDJSON transport and owned POSIX process-group supervision.
//! The supported Workerd launcher inherits this private group; inspector hooks are
//! disabled. This is not containment for arbitrary descendants that call setsid.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::{fd::AsRawFd, unix::process::CommandExt};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const PROTOCOL: &str = "can.dev.runtime.v1";
pub const MAX_FRAME: usize = 64 * 1024;
pub const MAX_STDERR: usize = 64 * 1024;
const MAX_PENDING: usize = 16;
const MAX_RETAINED: usize = 64;
// Fixed SDK methods advertised by dev-server/host/sdk.mjs. Development jobs
// themselves execute in the native owner.
const REQUIRED_COMMANDS: &[&str] = &[
    "node.resolve",
    "runtime.constants",
    "metadata.parse",
    "mf.create",
    "mf.dispose",
    "mf.scheduled",
    "d1.query",
    "r2.put",
    "r2.get",
    "r2.delete",
    "identity.ensureSchema",
    "identity.createTeam",
    "identity.createUser",
    "identity.createMembership",
    "identity.findUserByEmail",
    "identity.findTeamById",
    "identity.setMemberRole",
    "identity.hashPassword",
    "identity.csrf",
    "identity.resolve",
    "state.ensureSchema",
    "state.ownerScoped",
    "state.hashInputs",
    "semantic.activate",
    "semantic.appDefinition",
    "bundle.build",
    "bundle.assert",
    "testkit.load",
    "testkit.row",
    "testkit.stage",
    "testkit.report",
    "testkit.dispose",
    "browser.executable",
    "browser.launch",
    "browser.newContext",
    "browser.newPage",
    "browser.goto",
    "browser.request",
    "browser.cookies",
    "browser.locator",
    "browser.submit",
    "browser.title",
    "browser.close",
    "consume",
    "cancel",
    "release",
    "retry",
];

#[derive(Clone, Debug)]
pub struct BridgeConfig {
    pub node: PathBuf,
    pub host_script: PathBuf,
    pub cwd: PathBuf,
    pub session_id: String,
    pub profile: String,
    pub startup_timeout: Duration,
    pub install_root: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorKind {
    Configuration,
    Spawn,
    Protocol,
    Io,
    Disconnected,
    Deadline,
    Cancelled,
    Capacity,
    IncompleteCleanup,
}

pub struct BridgeError {
    pub kind: ErrorKind,
    pub message: String,
    /// Startup failures retain an incompletely released host for an explicit retry.
    pub retained: Option<Box<Bridge>>,
}
impl fmt::Debug for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BridgeError")
            .field("kind", &self.kind)
            .field("message", &self.message)
            .field("retained", &self.retained.is_some())
            .finish()
    }
}
impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for BridgeError {}
type Result<T> = std::result::Result<T, BridgeError>;
fn failure(kind: ErrorKind, message: &str) -> BridgeError {
    BridgeError {
        kind,
        message: message.into(),
        retained: None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Allocation {
    None,
    Owned,
    Released,
    ReleaseFailed,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeError {
    pub code: String,
    pub message: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
    pub protocol: String,
    pub kind: String,
    pub session_id: String,
    pub operation_id: String,
    pub generation_id: Option<String>,
    pub ok: bool,
    pub allocation: Allocation,
    pub result: Option<Value>,
    pub error: Option<RuntimeError>,
}
fn decode_reply(bytes: &[u8]) -> Option<Reply> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    // Missing generation is not the same wire identity as an explicit null.
    if !value.as_object()?.contains_key("generationId") {
        return None;
    }
    serde_json::from_value(value).ok()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    protocol: String,
    kind: String,
    session_id: String,
    pid: u32,
    profile: String,
    commands: Vec<String>,
}

#[derive(Debug)]
enum ReaderEvent {
    Frame(Vec<u8>),
    Fault,
    Closed,
}

/// A capped read does not allocate an arbitrarily long unterminated frame.
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "incomplete runtime frame",
                ))
            };
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(bytes.len(), |index| index + 1);
        if frame.len() + consumed > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runtime frame exceeds limit",
            ));
        }
        frame.extend_from_slice(&bytes[..consumed]);
        reader.consume(consumed);
        if newline.is_some() {
            frame.pop();
            return Ok(Some(frame));
        }
    }
}
fn read_stdout(
    reader: impl Read + Send + 'static,
    sender: SyncSender<ReaderEvent>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        loop {
            let event = match read_frame(&mut reader) {
                Ok(Some(frame)) => ReaderEvent::Frame(frame),
                Ok(None) => ReaderEvent::Closed,
                Err(_) => ReaderEvent::Fault,
            };
            let done = !matches!(event, ReaderEvent::Frame(_));
            if sender.send(event).is_err() || done {
                break;
            }
        }
    })
}

#[derive(Default)]
struct LogStore {
    bytes: Vec<u8>,
    dropped_bytes: u64,
}
#[derive(Clone, Debug)]
pub struct StderrSnapshot {
    pub text: String,
    pub dropped_bytes: u64,
}
#[derive(Clone, Copy, Default)]
enum EscapeState {
    #[default]
    Text,
    Escape,
    Csi,
    String,
    StringEscape,
}
fn read_stderr(
    mut reader: impl Read + Send + 'static,
    logs: Arc<Mutex<LogStore>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0; 2048];
        let mut state = EscapeState::Text;
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let mut clean = Vec::with_capacity(count);
            for byte in &buffer[..count] {
                match state {
                    EscapeState::Text => match *byte {
                        0x1b => state = EscapeState::Escape,
                        b'\n' => clean.push(b'\n'),
                        0..=31 | 127 => clean.push(b' '),
                        _ => clean.push(*byte),
                    },
                    EscapeState::Escape => {
                        state = match *byte {
                            b'[' => EscapeState::Csi,
                            b']' | b'P' | b'X' | b'^' | b'_' => EscapeState::String,
                            _ => EscapeState::Text,
                        }
                    }
                    EscapeState::Csi => {
                        if (b'@'..=b'~').contains(byte) {
                            state = EscapeState::Text;
                        }
                    }
                    EscapeState::String => match *byte {
                        7 => state = EscapeState::Text,
                        27 => state = EscapeState::StringEscape,
                        _ => {}
                    },
                    EscapeState::StringEscape => {
                        state = if *byte == b'\\' {
                            EscapeState::Text
                        } else {
                            EscapeState::String
                        }
                    }
                }
            }
            let Ok(mut store) = logs.lock() else {
                break;
            };
            let remaining = MAX_STDERR.saturating_sub(store.bytes.len());
            store
                .bytes
                .extend_from_slice(&clean[..remaining.min(clean.len())]);
            store.dropped_bytes = store
                .dropped_bytes
                .saturating_add(clean.len().saturating_sub(remaining) as u64);
        }
    })
}

/// Shared transport. Requests hold the wire lock only while writing or draining a
/// bounded event batch, allowing cancellation/release alongside long preparation.
pub struct Bridge {
    state: Mutex<BridgeState>,
    closing: AtomicBool,
    pid: u32,
    logs: Arc<Mutex<LogStore>>,
}
impl Bridge {
    fn from_state(state: BridgeState) -> Self {
        Self {
            pid: state.child.id(),
            logs: state.logs.clone(),
            state: Mutex::new(state),
            closing: AtomicBool::new(false),
        }
    }
    pub fn spawn(config: BridgeConfig) -> Result<Self> {
        BridgeState::spawn(config).map(Self::from_state)
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }

    fn lock_until(
        &self,
        deadline: Instant,
        cancel: Option<&AtomicBool>,
    ) -> Result<std::sync::MutexGuard<'_, BridgeState>> {
        loop {
            if cancel.is_some_and(|cancel| cancel.load(Ordering::Acquire)) {
                return Err(failure(ErrorKind::Cancelled, "Runtime request cancelled"));
            }
            if Instant::now() >= deadline {
                return Err(failure(
                    ErrorKind::Deadline,
                    "Runtime request deadline exceeded",
                ));
            }
            match self.state.try_lock() {
                Ok(state) => return Ok(state),
                Err(std::sync::TryLockError::Poisoned(poison)) => return Ok(poison.into_inner()),
                Err(std::sync::TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(2)),
            }
        }
    }

    /// Cancellation/deadline ends the wait, not allocation ownership. Late replies
    /// remain queued and can be drained while another operation is in progress.
    pub fn request(
        &self,
        command: &str,
        operation: &str,
        generation: Option<&str>,
        payload: Value,
        deadline: Instant,
        cancel: &AtomicBool,
    ) -> Result<Reply> {
        if self.closing.load(Ordering::Acquire) {
            return Err(failure(
                ErrorKind::Disconnected,
                "Runtime bridge is closing",
            ));
        }
        let (key, active) = self.lock_until(deadline, Some(cancel))?.begin_request(
            command,
            operation,
            generation,
            payload,
            deadline,
            cancel,
            &self.closing,
        )?;
        let _waiter = ActiveWaiter(active);
        loop {
            let mut state = self.lock_until(deadline, Some(cancel))?;
            state.pump();
            if self.closing.load(Ordering::Acquire) {
                return Err(failure(
                    ErrorKind::Cancelled,
                    "Runtime bridge is closing; late allocation facts remain retained",
                ));
            }
            if let Some(index) = state
                .retained
                .iter()
                .position(|reply| reply.operation_id == key.0 && reply.generation_id == key.1)
            {
                let reply = state
                    .retained
                    .remove(index)
                    .expect("selected retained reply");
                state.active.remove(&key);
                return Ok(reply);
            }
            state.check_transport()?;
            drop(state);
            thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn drain_retained(&self) -> Vec<Reply> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .drain_retained()
    }
    pub fn stderr(&self) -> StderrSnapshot {
        stderr_snapshot(&self.logs)
    }
    /// Consume only bounded transport evidence; no request or log inference.
    pub fn check_health(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.pump();
        state.check_transport()
    }
    pub fn shutdown(&self, deadline: Instant) -> Result<()> {
        self.closing.store(true, Ordering::Release);
        self.lock_until(deadline, None)?.shutdown(deadline)
    }
}

struct ActiveWaiter(Arc<AtomicBool>);
impl Drop for ActiveWaiter {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct BridgeState {
    child: Child,
    input: Option<ChildStdin>,
    events: Receiver<ReaderEvent>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    logs: Arc<Mutex<LogStore>>,
    session_id: String,
    commands: HashSet<String>,
    pending: HashSet<(String, Option<String>)>,
    active: HashMap<(String, Option<String>), Arc<AtomicBool>>,
    retained: VecDeque<Reply>,
    fault: Option<ErrorKind>,
    closed: bool,
    reaped: bool,
    forced: bool,
    released: bool,
    group: i32,
}

impl BridgeState {
    #[cfg(unix)]
    pub fn spawn(config: BridgeConfig) -> Result<Self> {
        if !valid_id(&config.session_id)
            || !valid_id(&config.profile)
            || config.startup_timeout.is_zero()
        {
            return Err(failure(
                ErrorKind::Configuration,
                "Invalid runtime bridge configuration",
            ));
        }
        let mut command = Command::new(&config.node);
        command
            .arg(&config.host_script)
            .arg("--session")
            .arg(&config.session_id)
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_INSPECTOR_INFO")
            .env_remove("VSCODE_INSPECTOR_OPTIONS");
        if let Some(root) = &config.install_root {
            command.env("CAN_INSTALL_ROOT", root);
        }
        // Only async-signal-safe OS calls run between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command
            .spawn()
            .map_err(|_| failure(ErrorKind::Spawn, "Runtime host could not be spawned"))?;
        let group = i32::try_from(child.id()).map_err(|_| {
            failure(
                ErrorKind::Spawn,
                "Runtime child PID is outside supported range",
            )
        })?;
        let input = child.stdin.take();
        let output = child.stdout.take().expect("piped runtime stdout");
        let stderr = child.stderr.take().expect("piped runtime stderr");
        let (sender, events) = mpsc::sync_channel(64);
        let logs = Arc::new(Mutex::new(LogStore::default()));
        let mut bridge = Self {
            child,
            input,
            events,
            stdout_thread: Some(read_stdout(output, sender)),
            stderr_thread: Some(read_stderr(stderr, logs.clone())),
            logs,
            session_id: config.session_id.clone(),
            commands: HashSet::new(),
            pending: HashSet::new(),
            active: HashMap::new(),
            retained: VecDeque::new(),
            fault: None,
            closed: false,
            reaped: false,
            forced: false,
            released: false,
            group,
        };
        let startup = (|| {
            bridge.verify_anchor()?;
            if let Some(input) = &bridge.input {
                set_nonblocking(input)?;
            }
            let deadline = Instant::now() + config.startup_timeout;
            let bytes = match bridge
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(ReaderEvent::Frame(bytes)) => bytes,
                Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(failure(
                        ErrorKind::Disconnected,
                        "Runtime host closed before readiness",
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(failure(
                        ErrorKind::Deadline,
                        "Runtime host readiness deadline exceeded",
                    ));
                }
            };
            let ready: Ready = serde_json::from_slice(&bytes)
                .map_err(|_| failure(ErrorKind::Protocol, "Invalid runtime readiness frame"))?;
            if ready.protocol != PROTOCOL
                || ready.kind != "ready"
                || ready.session_id != config.session_id
                || ready.pid != bridge.child.id()
                || ready.profile != config.profile
                || ready.commands.len() > 64
                || ready.commands.iter().any(|command| !valid_id(command))
                || REQUIRED_COMMANDS
                    .iter()
                    .any(|command| !ready.commands.iter().any(|ready| ready == command))
            {
                return Err(failure(
                    ErrorKind::Protocol,
                    "Runtime readiness identity/profile/commands mismatch",
                ));
            }
            bridge.commands = ready.commands.into_iter().collect();
            Ok(())
        })();
        if let Err(mut error) = startup {
            if bridge
                .shutdown(Instant::now() + Duration::from_secs(2))
                .is_err()
            {
                error.retained = Some(Box::new(Bridge::from_state(bridge)));
            }
            return Err(error);
        }
        Ok(bridge)
    }

    #[cfg(not(unix))]
    pub fn spawn(_: BridgeConfig) -> Result<Self> {
        Err(failure(
            ErrorKind::Configuration,
            "Runtime process ownership requires POSIX support",
        ))
    }

    fn begin_request(
        &mut self,
        command: &str,
        operation: &str,
        generation: Option<&str>,
        payload: Value,
        deadline: Instant,
        cancel: &AtomicBool,
        closing: &AtomicBool,
    ) -> Result<((String, Option<String>), Arc<AtomicBool>)> {
        self.pump();
        self.check_transport()?;
        if !self.commands.contains(command)
            || !valid_id(operation)
            || generation.is_some_and(|id| !valid_id(id))
            || !payload.is_object()
        {
            return Err(failure(
                ErrorKind::Protocol,
                "Invalid or unsupported runtime request",
            ));
        }
        let key = (operation.to_string(), generation.map(str::to_string));
        if self.pending.contains(&key) {
            return Err(failure(
                ErrorKind::Protocol,
                "Runtime operation/generation is already pending",
            ));
        }
        if self.pending.len()
            >= MAX_PENDING
                + if matches!(command, "cancel" | "release" | "retry") {
                    8
                } else {
                    0
                }
            || self.retained.len() >= MAX_RETAINED
        {
            return Err(failure(
                ErrorKind::Capacity,
                "Drain retained runtime replies before issuing more requests",
            ));
        }
        let mut frame =
            serde_json::to_vec(&json!({"protocol":PROTOCOL,"sessionId":self.session_id,
            "operationId":operation,"generationId":generation,"command":command,"payload":payload}))
            .map_err(|_| failure(ErrorKind::Protocol, "Runtime request cannot be encoded"))?;
        frame.push(b'\n');
        if frame.len() > MAX_FRAME {
            return Err(failure(
                ErrorKind::Protocol,
                "Runtime request exceeds frame limit",
            ));
        }
        self.pending.insert(key.clone());
        let active = Arc::new(AtomicBool::new(true));
        self.active.insert(key.clone(), active.clone());
        if let Err(error) = self.write_frame(&frame, deadline, cancel, closing) {
            active.store(false, Ordering::Release);
            return Err(error);
        }
        Ok((key, active))
    }

    fn write_frame(
        &mut self,
        bytes: &[u8],
        deadline: Instant,
        cancel: &AtomicBool,
        closing: &AtomicBool,
    ) -> Result<()> {
        let mut offset = 0;
        while offset < bytes.len() {
            let error = if cancel.load(Ordering::Acquire) || closing.load(Ordering::Acquire) {
                Some(failure(ErrorKind::Cancelled, "Runtime write cancelled"))
            } else if Instant::now() >= deadline {
                Some(failure(
                    ErrorKind::Deadline,
                    "Runtime write deadline exceeded",
                ))
            } else {
                None
            };
            if let Some(error) = error {
                // An unfinished NDJSON write cannot be followed by another command.
                self.input.take();
                self.fault = Some(error.kind);
                return Err(error);
            }
            match self
                .input
                .as_mut()
                .ok_or_else(|| failure(ErrorKind::Disconnected, "Runtime input closed"))?
                .write(&bytes[offset..])
            {
                Ok(0) => {
                    self.fault = Some(ErrorKind::Disconnected);
                    return Err(failure(ErrorKind::Disconnected, "Runtime input closed"));
                }
                Ok(count) => offset += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.pump();
                    thread::sleep(Duration::from_millis(2));
                }
                Err(_) => {
                    self.fault = Some(ErrorKind::Io);
                    return Err(failure(ErrorKind::Io, "Runtime input write failed"));
                }
            }
        }
        Ok(())
    }

    fn accept(&mut self, event: ReaderEvent) {
        match event {
            ReaderEvent::Frame(bytes) => {
                let reply = match decode_reply(&bytes) {
                    Some(reply) => reply,
                    None => {
                        self.fault = Some(ErrorKind::Protocol);
                        return;
                    }
                };
                if reply.protocol != PROTOCOL
                    || reply.kind != "result"
                    || reply.session_id != self.session_id
                    || !valid_id(&reply.operation_id)
                    || reply
                        .generation_id
                        .as_deref()
                        .is_some_and(|id| !valid_id(id))
                    || reply
                        .error
                        .as_ref()
                        .is_some_and(|error| !valid_id(&error.code) || error.message.len() > 4096)
                {
                    self.fault = Some(ErrorKind::Protocol);
                    return;
                }
                if !self
                    .pending
                    .remove(&(reply.operation_id.clone(), reply.generation_id.clone()))
                {
                    self.fault = Some(ErrorKind::Protocol);
                }
                // Retain allocation facts even when another request failed/cancelled.
                self.retained.push_back(reply);
            }
            ReaderEvent::Fault => self.fault = Some(ErrorKind::Protocol),
            ReaderEvent::Closed => self.closed = true,
        }
    }
    fn pump(&mut self) {
        for _ in 0..64 {
            if self.retained.len() >= MAX_RETAINED + MAX_PENDING + 8 {
                break;
            }
            match self.events.try_recv() {
                Ok(event) => self.accept(event),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.closed = true;
                    break;
                }
            }
        }
    }
    fn check_transport(&self) -> Result<()> {
        if self.released || self.closed {
            return Err(failure(
                ErrorKind::Disconnected,
                "Runtime transport closed; release must still be verified",
            ));
        }
        if let Some(kind) = self.fault {
            return Err(failure(
                kind,
                "Runtime transport failed; retained allocations require release",
            ));
        }
        Ok(())
    }
    pub fn drain_retained(&mut self) -> Vec<Reply> {
        self.pump();
        let mut ready = Vec::new();
        let mut waiting = VecDeque::new();
        while let Some(reply) = self.retained.pop_front() {
            let key = (reply.operation_id.clone(), reply.generation_id.clone());
            if self
                .active
                .get(&key)
                .is_some_and(|active| active.load(Ordering::Acquire))
            {
                waiting.push_back(reply);
            } else {
                ready.push(reply);
                self.active.remove(&key);
            }
        }
        self.retained = waiting;
        ready
    }

    /// Success means direct-child reap AND absence of the private process group.
    /// Failure preserves this same handle for retry; no caller-supplied PID is killed.
    #[cfg(unix)]
    pub fn shutdown(&mut self, deadline: Instant) -> Result<()> {
        if self.released {
            return Ok(());
        }
        self.input.take();
        if !self.reaped {
            self.verify_anchor()?;
            self.wait_anchor_until((Instant::now() + Duration::from_millis(200)).min(deadline));
            if !self.forced {
                if self.signal_group(libc::SIGTERM)? {
                    self.wait_anchor_until(
                        (Instant::now() + Duration::from_millis(200)).min(deadline),
                    );
                    // Keep the unreaped leader as an identity anchor through the final
                    // signal, including a host crash with remaining Workerd children.
                    self.signal_group(libc::SIGKILL)?;
                }
                self.forced = true;
            }
            while !self.anchor_exited()? {
                self.pump();
                if Instant::now() >= deadline {
                    return Err(failure(
                        ErrorKind::IncompleteCleanup,
                        "Runtime child release is unconfirmed; retry cleanup with retained handle",
                    ));
                }
                thread::sleep(Duration::from_millis(5));
            }
            self.child.wait().map_err(|_| {
                failure(
                    ErrorKind::IncompleteCleanup,
                    "Runtime child could not be reaped; retain cleanup handle",
                )
            })?;
            self.reaped = true;
        }
        // No further signals are sent after reaping: the pinned PID could be reused.
        loop {
            self.pump();
            let result = unsafe { libc::kill(-self.group, 0) };
            if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            if Instant::now() >= deadline {
                return Err(failure(
                    ErrorKind::IncompleteCleanup,
                    "Runtime process group release is unconfirmed; retry cleanup with retained handle",
                ));
            }
            thread::sleep(Duration::from_millis(5));
        }
        self.join_streams(deadline)?;
        self.released = true;
        Ok(())
    }
    fn join_streams(&mut self, deadline: Instant) -> Result<()> {
        loop {
            self.pump();
            let finished = self
                .stdout_thread
                .as_ref()
                .is_none_or(|handle| handle.is_finished())
                && self
                    .stderr_thread
                    .as_ref()
                    .is_none_or(|handle| handle.is_finished());
            if finished {
                break;
            }
            if Instant::now() >= deadline {
                return Err(failure(
                    ErrorKind::IncompleteCleanup,
                    "Runtime stream closure is unconfirmed; retry cleanup",
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
        if let Some(handle) = self.stdout_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.stderr_thread.take() {
            let _ = handle.join();
        }
        Ok(())
    }
    #[cfg(not(unix))]
    pub fn shutdown(&mut self, _: Instant) -> Result<()> {
        Err(failure(
            ErrorKind::IncompleteCleanup,
            "Unsupported process supervision platform",
        ))
    }

    #[cfg(unix)]
    fn verify_anchor(&self) -> Result<()> {
        // Some POSIX kernels stop exposing getpgid/getsid for zombies. waitid
        // WNOWAIT still proves this exact direct child has not been reaped, so its
        // initially verified session-leader PID cannot have been reused.
        if !self.reaped && self.anchor_exited()? {
            return Ok(());
        }

        if self.reaped
            || unsafe { libc::getpgid(self.group) } != self.group
            || unsafe { libc::getsid(self.group) } != self.group
        {
            return Err(failure(
                ErrorKind::IncompleteCleanup,
                "Runtime process ownership anchor could not be verified; no signal sent",
            ));
        }
        Ok(())
    }
    #[cfg(unix)]
    fn signal_group(&self, signal: i32) -> Result<bool> {
        self.verify_anchor()?;
        if unsafe { libc::kill(-self.group, signal) } == 0 {
            return Ok(true);
        }
        let errno = io::Error::last_os_error().raw_os_error();
        if errno == Some(libc::ESRCH) {
            return Ok(true);
        }
        // Darwin returns EPERM for an unreaped leader with no live group members.
        // Reaping our proven exited child is safe. Shutdown must THEN observe ESRCH
        // for the group before claiming release; EPERM alone never proves release.
        if errno == Some(libc::EPERM) && self.anchor_exited()? {
            return Ok(false);
        }
        Err(failure(
            ErrorKind::IncompleteCleanup,
            "Owned runtime process group could not be signalled; retain cleanup handle",
        ))
    }
    #[cfg(unix)]
    fn anchor_exited(&self) -> Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.child.id() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } == -1
        {
            return Err(failure(
                ErrorKind::IncompleteCleanup,
                "Runtime child identity/reap status is unavailable",
            ));
        }
        Ok(unsafe { info.si_pid() } != 0)
    }
    #[cfg(unix)]
    fn wait_anchor_until(&mut self, until: Instant) {
        while Instant::now() < until {
            self.pump();
            if self.anchor_exited().unwrap_or(false) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for BridgeState {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.shutdown(Instant::now() + Duration::from_millis(500));
        }
    }
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}
#[cfg(unix)]
fn set_nonblocking(input: &ChildStdin) -> Result<()> {
    let descriptor = input.as_raw_fd();
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags == -1
        || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        return Err(failure(
            ErrorKind::Io,
            "Runtime stdin could not be made deadline-aware",
        ));
    }
    Ok(())
}

fn stderr_snapshot(logs: &Arc<Mutex<LogStore>>) -> StderrSnapshot {
    let store = logs.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut text = String::new();
    for character in String::from_utf8_lossy(&store.bytes).chars() {
        let safe = if (character.is_control() && character != '\n')
            || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            ' '
        } else {
            character
        };
        if text.len() + safe.len_utf8() > MAX_STDERR {
            break;
        }
        text.push(safe);
    }
    StderrSnapshot {
        text,
        dropped_bytes: store.dropped_bytes,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, io::Cursor};

    const SCRIPT: &str = r#"
const sessionId=process.argv[process.argv.indexOf('--session')+1];
const protocol='can.dev.runtime.v1';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
send({protocol,kind:'ready',sessionId,pid:process.pid,profile:'local-d1-identity',commands:[...__SDK_COMMANDS__,'inventory','prepare','probe']});
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 const respond=()=>send({protocol,kind:'result',sessionId,operationId:request.operationId,generationId:request.generationId,ok:true,allocation:request.command==='prepare'?'owned':request.command==='release'?'released':'none',result:{command:request.command}});
 if(request.command==='prepare')setTimeout(respond,150);else respond();
});
process.stdin.on('end',()=>process.exit(0));
"#;

    fn fixture(script: &str) -> (tempfile::TempDir, BridgeConfig) {
        let directory = tempfile::tempdir().unwrap();
        let host_script = directory.path().join("host.cjs");
        fs::write(
            &host_script,
            script.replace(
                "__SDK_COMMANDS__",
                &serde_json::to_string(REQUIRED_COMMANDS).unwrap(),
            ),
        )
        .unwrap();
        let config = BridgeConfig {
            node: std::env::var_os("CAN_DEV_TEST_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("node")),
            host_script,
            cwd: directory.path().into(),
            session_id: "private-test-session".into(),
            profile: "local-d1-identity".into(),
            startup_timeout: Duration::from_secs(3),
            install_root: None,
        };
        (directory, config)
    }
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(3)
    }

    #[test]
    fn framing_rejects_overflow_partial_and_accepts_exact_bound() {
        assert_eq!(
            read_frame(&mut Cursor::new(b"{}\n")).unwrap(),
            Some(b"{}".to_vec())
        );
        let mut full = vec![b'x'; MAX_FRAME - 1];
        full.push(b'\n');
        assert_eq!(
            read_frame(&mut Cursor::new(full)).unwrap().unwrap().len(),
            MAX_FRAME - 1
        );
        assert!(read_frame(&mut Cursor::new(vec![b'x'; MAX_FRAME + 1])).is_err());
        assert!(read_frame(&mut Cursor::new(b"{}".as_slice())).is_err());
        let mut reply = json!({"protocol":PROTOCOL,"kind":"result","sessionId":"s","operationId":"o","generationId":null,"ok":true,"allocation":"none"});
        assert!(decode_reply(&serde_json::to_vec(&reply).unwrap()).is_some());
        reply.as_object_mut().unwrap().remove("generationId");
        assert!(decode_reply(&serde_json::to_vec(&reply).unwrap()).is_none());
    }

    #[test]
    fn ready_identity_profile_and_pid_are_verified_and_failed_spawn_releases() {
        for bad in [
            SCRIPT.replace("pid:process.pid", "pid:1"),
            SCRIPT.replace("profile:'local-d1-identity'", "profile:'wrong'"),
            SCRIPT.replace("__SDK_COMMANDS__", "[]"),
        ] {
            let (_directory, config) = fixture(&bad);
            let error = match Bridge::spawn(config) {
                Ok(_) => panic!("invalid readiness accepted"),
                Err(error) => error,
            };
            assert_eq!(error.kind, ErrorKind::Protocol);
            assert!(
                error.retained.is_none(),
                "cleanup was not confirmed: {error:?}"
            );
        }
    }

    #[test]
    fn concurrent_inventory_does_not_wait_for_prepare_and_drain_does_not_steal_live_reply() {
        let (_directory, config) = fixture(SCRIPT);
        let bridge = Arc::new(Bridge::spawn(config).unwrap());
        let preparing = bridge.clone();
        let worker = thread::spawn(move || {
            preparing
                .request(
                    "prepare",
                    "prepare-one",
                    Some("g1"),
                    json!({}),
                    deadline(),
                    &AtomicBool::new(false),
                )
                .unwrap()
        });
        thread::sleep(Duration::from_millis(20));
        let started = Instant::now();
        let inventory = bridge
            .request(
                "inventory",
                "inventory-one",
                None,
                json!({}),
                deadline(),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(inventory.result.unwrap()["command"], "inventory");
        assert!(started.elapsed() < Duration::from_millis(130));
        assert!(bridge.drain_retained().is_empty());
        assert_eq!(worker.join().unwrap().allocation, Allocation::Owned);
        bridge.shutdown(deadline()).unwrap();
        assert_eq!(unsafe { libc::kill(-(bridge.pid() as i32), 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    #[test]
    fn cancellation_and_deadline_preserve_late_allocation_facts() {
        let (_directory, config) = fixture(SCRIPT);
        let bridge = Arc::new(Bridge::spawn(config).unwrap());
        let cancel = Arc::new(AtomicBool::new(false));
        let pending = bridge.clone();
        let cancellation = cancel.clone();
        let worker = thread::spawn(move || {
            pending.request(
                "prepare",
                "cancelled",
                Some("g-cancelled"),
                json!({}),
                deadline(),
                &cancellation,
            )
        });
        thread::sleep(Duration::from_millis(30));
        cancel.store(true, Ordering::Release);
        assert_eq!(
            worker.join().unwrap().unwrap_err().kind,
            ErrorKind::Cancelled
        );
        let timed = bridge.request(
            "prepare",
            "timed-out",
            Some("g-timed-out"),
            json!({}),
            Instant::now() + Duration::from_millis(20),
            &AtomicBool::new(false),
        );
        assert_eq!(timed.unwrap_err().kind, ErrorKind::Deadline);
        thread::sleep(Duration::from_millis(200));
        let retained = bridge.drain_retained();
        assert_eq!(retained.len(), 2);
        assert!(
            retained
                .iter()
                .all(|reply| reply.allocation == Allocation::Owned)
        );
        let released = bridge
            .request(
                "release",
                "release-cancelled",
                Some("g-cancelled"),
                json!({}),
                deadline(),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(released.allocation, Allocation::Released);
        bridge.shutdown(deadline()).unwrap();
    }

    #[test]
    fn stderr_is_sanitized_bounded_and_reports_dropped_bytes() {
        let script = format!(
            "process.stderr.write('\\x1b[31mred\\x1b[0m\\u202e'+'x'.repeat(100000));\n{SCRIPT}"
        );
        let (_directory, config) = fixture(&script);
        let bridge = Bridge::spawn(config).unwrap();
        bridge
            .request(
                "inventory",
                "logs",
                None,
                json!({}),
                deadline(),
                &AtomicBool::new(false),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(20));
        let logs = bridge.stderr();
        assert!(logs.text.starts_with("red "));
        assert!(!logs.text.contains('\x1b'));
        assert!(!logs.text.contains('\u{202e}'));
        assert!(logs.text.len() <= MAX_STDERR);
        assert!(logs.dropped_bytes > 0);
        bridge.shutdown(deadline()).unwrap();
    }

    #[test]
    fn mismatched_generation_cannot_complete_request_but_allocation_is_retained() {
        let script = SCRIPT.replace(
            "generationId:request.generationId",
            "generationId:'wrong-generation'",
        );
        let (_directory, config) = fixture(&script);
        let bridge = Bridge::spawn(config).unwrap();
        let error = bridge
            .request(
                "inventory",
                "correlated",
                Some("expected"),
                json!({}),
                deadline(),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Protocol);
        let retained = bridge.drain_retained();
        assert_eq!(retained.len(), 1);
        assert_eq!(
            retained[0].generation_id.as_deref(),
            Some("wrong-generation")
        );
        bridge.shutdown(deadline()).unwrap();
    }

    #[test]
    fn host_crash_releases_non_detached_descendant_and_does_not_touch_foreign_group() {
        let script = SCRIPT.replace("const protocol=", "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\nconst protocol=");
        let (_directory, config) = fixture(&script);
        let bridge = Bridge::spawn(config).unwrap();
        let mut foreign = Command::new("sleep").arg("10").spawn().unwrap();
        assert_eq!(unsafe { libc::kill(bridge.pid() as i32, libc::SIGKILL) }, 0);
        let until = deadline();
        while bridge.check_health().is_ok() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            bridge.check_health().unwrap_err().kind,
            ErrorKind::Disconnected
        );
        bridge.shutdown(deadline()).unwrap();
        assert!(foreign.try_wait().unwrap().is_none());
        foreign.kill().unwrap();
        foreign.wait().unwrap();
    }

    #[test]
    fn expired_shutdown_retains_same_handle_for_retry() {
        let (_directory, config) = fixture(SCRIPT);
        let bridge = Bridge::spawn(config).unwrap();
        assert_eq!(
            bridge.shutdown(Instant::now()).unwrap_err().kind,
            ErrorKind::Deadline
        );
        bridge.shutdown(deadline()).unwrap();
        bridge.shutdown(deadline()).unwrap();
    }
}
