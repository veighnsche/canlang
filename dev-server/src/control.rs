//! The retained can.dev.control.v1 newline-JSON protocol. A detached caller
//! only closes its own connection; shared owner work has separate cancellation.
use crate::claim::{self, Claim, ControlError, Identity, Lookup, Result, Selection};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_REQUEST: usize = 64 * 1024;
const MAX_RESPONSE: usize = 128 * 1024;
const HANDSHAKE: Duration = Duration::from_millis(1500);
const REQUEST: Duration = Duration::from_secs(60);
const REQUEST_LONG: Duration = Duration::from_secs(600);
/// Commands that stage datasets, execute examples or boot/probe workers
/// exceed the interactive deadline on real apps; everything else stays
/// at 60s so a stuck trivial command still fails fast.
pub fn request_deadline(command: &str) -> Duration {
    match command {
        "start" | "check" | "example.run" | "example.rerun" | "preview.open" => REQUEST_LONG,
        _ => REQUEST,
    }
}
const MAX_CONNECTIONS: usize = 32;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Command {
    pub command: String,
    #[serde(default)]
    pub payload: Value,
}
pub type Handler = dyn Fn(Command) -> Result<Value> + Send + Sync + 'static;
pub type CancellableHandler =
    dyn Fn(Command, Arc<AtomicBool>) -> Result<Value> + Send + Sync + 'static;
fn io(error: std::io::Error) -> ControlError {
    ControlError::new("CONTROL_IO", error.to_string())
}
fn frame_error(code: &str, message: &str) -> ControlError {
    ControlError::new(code, message)
}
fn detached(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(frame_error(
            "REQUEST_ABORTED",
            "control request was detached",
        ))
    } else {
        Ok(())
    }
}
fn transient(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}
fn stream_options(stream: &UnixStream) -> Result<()> {
    stream.set_nonblocking(false).map_err(io)?;
    stream
        .set_read_timeout(Some(Duration::from_millis(20)))
        .map_err(io)?;
    stream
        .set_write_timeout(Some(Duration::from_millis(20)))
        .map_err(io)
}
fn write_frame(
    stream: &mut UnixStream,
    value: &Value,
    limit: usize,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| {
        frame_error(
            "INVALID_RESPONSE",
            "control response is not JSON serializable",
        )
    })?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err(frame_error(
            "RESPONSE_TOO_LARGE",
            "control frame exceeds byte limit",
        ));
    }
    let deadline = Instant::now() + HANDSHAKE;
    let mut written = 0;
    while written < bytes.len() {
        detached(cancel)?;
        if Instant::now() > deadline {
            return Err(frame_error("CONTROL_TIMEOUT", "control endpoint timed out"));
        }
        match stream.write(&bytes[written..]) {
            Ok(0) => return Err(frame_error("CONTROL_CLOSED", "control endpoint closed")),
            Ok(count) => written += count,
            Err(error) if transient(&error) => {}
            Err(error) => return Err(io(error)),
        }
    }
    Ok(())
}
struct Frames {
    pending: Vec<u8>,
}
impl Frames {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }
    fn read(
        &mut self,
        stream: &mut UnixStream,
        max: usize,
        timeout: Duration,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        let mut chunk = [0; 8192];
        loop {
            detached(cancel)?;
            if Instant::now() >= deadline {
                return Err(frame_error("CONTROL_TIMEOUT", "control endpoint timed out"));
            }
            if self.pending.len() > max {
                return Err(frame_error(
                    "RESPONSE_TOO_LARGE",
                    "control frame exceeds byte limit",
                ));
            }
            if let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                let value = serde_json::from_slice(&self.pending[..end]).map_err(|_| {
                    frame_error("INVALID_RESPONSE", "control endpoint returned invalid JSON")
                })?;
                self.pending.drain(..=end);
                return Ok(value);
            }
            match stream.read(&mut chunk) {
                Ok(0) => return Err(frame_error("CONTROL_CLOSED", "control endpoint closed")),
                Ok(count) => self.pending.extend_from_slice(&chunk[..count]),
                Err(error) if transient(&error) => {}
                Err(error) => return Err(io(error)),
            }
        }
    }
}
fn hello_value(identity: &Identity, nonce: &str) -> Result<Value> {
    let mut value = serde_json::to_value(identity)
        .map_err(|e| ControlError::new("INVALID_DESCRIPTOR", e.to_string()))?;
    value["type"] = "hello".into();
    value["nonce"] = nonce.into();
    Ok(value)
}
fn matching_hello(frame: &Value, identity: &Identity, nonce: &str) -> bool {
    hello_value(identity, nonce).is_ok_and(|expected| frame == &expected)
}
fn handshake(stream: &mut UnixStream, expected: &Identity, cancel: &AtomicBool) -> Result<()> {
    let nonce = claim::nonce(16)?;
    write_frame(stream, &hello_value(expected, &nonce)?, MAX_REQUEST, cancel)?;
    let answer = Frames::new().read(stream, MAX_RESPONSE, HANDSHAKE, cancel)?;
    if !matching_hello(&answer, expected, &nonce) {
        return Err(frame_error(
            "SESSION_MISMATCH",
            "control handshake did not match selected session",
        ));
    }
    Ok(())
}
fn dial(identity: &Identity, cancel: &AtomicBool) -> Result<UnixStream> {
    detached(cancel)?;
    claim::private_file(Path::new(&identity.socket_path), true)?;
    let stream = connect_bounded(Path::new(&identity.socket_path), cancel)?;
    stream_options(&stream)?;
    detached(cancel)?;
    Ok(stream)
}
fn connect_bounded(path: &Path, cancel: &AtomicBool) -> Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= address.sun_path.len() {
        return Err(frame_error(
            "SOCKET_PATH_TOO_LONG",
            "control socket path exceeds Unix limit",
        ));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let length =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    #[cfg(target_os = "macos")]
    {
        address.sun_len = length as u8;
    }
    #[cfg(target_os = "linux")]
    let flags = libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK;
    #[cfg(not(target_os = "linux"))]
    let flags = libc::SOCK_STREAM;
    let raw = unsafe { libc::socket(libc::AF_UNIX, flags, 0) };
    if raw < 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe { libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
        || unsafe { libc::fcntl(raw, libc::F_SETFL, libc::O_NONBLOCK) } < 0
    {
        return Err(io(std::io::Error::last_os_error()));
    }
    let status =
        unsafe { libc::connect(raw, (&address as *const libc::sockaddr_un).cast(), length) };
    if status != 0 {
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINPROGRESS | libc::EAGAIN | libc::EALREADY)
        ) {
            return Err(io(error));
        }
        wait_connect(&fd, cancel)?;
    }
    Ok(UnixStream::from(fd))
}
fn wait_connect(fd: &OwnedFd, cancel: &AtomicBool) -> Result<()> {
    let deadline = Instant::now() + HANDSHAKE;
    loop {
        detached(cancel)?;
        if Instant::now() >= deadline {
            return Err(frame_error(
                "CONTROL_TIMEOUT",
                "control endpoint did not connect",
            ));
        }
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        let status = unsafe { libc::poll(&mut poll, 1, 20) };
        if status < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io(error));
        }
        if status > 0 {
            return connected_status(fd);
        }
    }
}
fn connected_status(fd: &OwnedFd) -> Result<()> {
    let mut error = 0i32;
    let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
    let status = unsafe {
        libc::getsockopt(
            fd.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_ERROR,
            (&mut error as *mut i32).cast(),
            &mut length,
        )
    };
    if status != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    if error != 0 {
        return Err(io(std::io::Error::from_raw_os_error(error)));
    }
    Ok(())
}
pub(crate) fn verify_live(identity: &Identity) -> bool {
    let cancel = AtomicBool::new(false);
    dial(identity, &cancel)
        .and_then(|mut stream| handshake(&mut stream, identity, &cancel))
        .is_ok()
}
#[derive(Clone, Debug)]
pub struct Client {
    pub identity: Identity,
}
impl Client {
    pub fn discover(lookup: &Lookup) -> Result<Self> {
        let identity = claim::discover(lookup)?;
        if !verify_live(&identity) {
            return Err(frame_error(
                "SESSION_MISMATCH",
                "control handshake did not match selected session",
            ));
        }
        Ok(Self { identity })
    }
    pub fn request(&self, command: Command, cancel: &AtomicBool) -> Result<Value> {
        if command.command.is_empty() || command.command.len() > 100 {
            return Err(frame_error("INVALID_COMMAND", "control command is invalid"));
        }
        let mut stream = dial(&self.identity, cancel)?;
        handshake(&mut stream, &self.identity, cancel)?;
        let id = claim::nonce(8)?;
        let frame =
            json!({"type":"request","id":id,"command":command.command,"payload":command.payload});
        let size = serde_json::to_vec(&frame)
            .map_err(|e| ControlError::new("INVALID_COMMAND", e.to_string()))?
            .len()
            + 1;
        if size > MAX_REQUEST {
            return Err(frame_error(
                "REQUEST_TOO_LARGE",
                "control request exceeds byte limit",
            ));
        }
        write_frame(&mut stream, &frame, MAX_REQUEST, cancel)?;
        let answer = Frames::new().read(
            &mut stream,
            MAX_RESPONSE,
            request_deadline(&command.command) + Duration::from_millis(1500),
            cancel,
        )?;
        response_value(answer, &id)
    }
}
fn response_value(answer: Value, id: &str) -> Result<Value> {
    if answer["type"] != "response" || answer["id"] != id || !answer["ok"].is_boolean() {
        return Err(frame_error(
            "INVALID_RESPONSE",
            "control response does not match request",
        ));
    }
    if answer["ok"] == true {
        return Ok(answer["result"].clone());
    }
    Err(ControlError::new(
        answer["error"]["code"].as_str().unwrap_or("REQUEST_FAILED"),
        answer["error"]["message"]
            .as_str()
            .unwrap_or("control request failed"),
    ))
}
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
pub struct Server {
    pub identity: Identity,
    claim: Arc<Mutex<Claim>>,
    stopped: Arc<AtomicBool>,
    accepting: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    pub fn start(selection: Selection, handler: Arc<Handler>) -> Result<Self> {
        Self::start_cancellable(selection, Arc::new(move |command, _| handler(command)))
    }
    pub fn start_cancellable(
        selection: Selection,
        handler: Arc<CancellableHandler>,
    ) -> Result<Self> {
        let claim = Claim::acquire(&selection)?;
        let identity = claim.identity.clone();
        let claim = Arc::new(Mutex::new(claim));
        let stopped = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicUsize::new(0));
        let accepting = Arc::new(AtomicBool::new(true));
        let connections = Arc::new(AtomicUsize::new(0));
        let owner = claim.clone();
        let stop = stopped.clone();
        let admission = accepting.clone();
        let connected = connections.clone();
        let thread =
            thread::spawn(move || accept_loop(owner, stop, admission, connected, active, handler));
        Ok(Self {
            identity,
            claim,
            stopped,
            accepting,
            connections,
            thread: Some(thread),
        })
    }
    /// Pause accepts and retire only after every already accepted connection
    /// has completed its response write. Polling keeps the owner loop responsive.
    /// Call after sending all stop-confirmation results to their handlers.
    pub fn retire_when_drained(&mut self) -> Result<bool> {
        self.accepting.store(false, Ordering::Release);
        let retired = {
            // Acceptance increments the connection count under this same lock,
            // so zero cannot race with a previously accepted uncounted stream.
            let mut claim = self
                .claim
                .lock()
                .map_err(|_| frame_error("CLAIM_LOST", "claim lock is unavailable"))?;
            if self.connections.load(Ordering::Acquire) != 0 {
                return Ok(false);
            }
            claim.retire()
        };
        if let Err(error) = retired {
            self.accepting.store(true, Ordering::Release);
            return Err(error);
        }
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        Ok(true)
    }
    /// Bounded convenience for non-loop callers. A timed-out or failed drain
    /// restores accepts and retains the endpoint and claim for explicit retry.
    pub fn stop(&mut self) -> Result<()> {
        let deadline = Instant::now() + HANDSHAKE;
        loop {
            if self.retire_when_drained()? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                self.accepting.store(true, Ordering::Release);
                return Err(frame_error(
                    "CONTROL_BUSY",
                    "control responses have not finished; retry retirement",
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn require_ownership(&self) -> Result<()> {
        self.claim
            .lock()
            .map_err(|_| frame_error("CLAIM_LOST", "claim lock is unavailable"))?
            .require_ownership()
    }
}
fn accept_loop(
    claim: Arc<Mutex<Claim>>,
    stopped: Arc<AtomicBool>,
    accepting: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    handler: Arc<CancellableHandler>,
) {
    while !stopped.load(Ordering::Acquire) {
        let accepted = claim.lock().ok().and_then(|c| {
            if !accepting.load(Ordering::Acquire) {
                return None;
            }
            c.accept().ok().flatten().map(|stream| {
                connections.fetch_add(1, Ordering::AcqRel);
                (stream, c.identity.clone(), Permit(connections.clone()))
            })
        });
        if let Some((stream, identity, connection)) = accepted {
            if active.fetch_add(1, Ordering::AcqRel) < MAX_CONNECTIONS {
                let permit = Permit(active.clone());
                let handler = handler.clone();
                let stop = stopped.clone();
                thread::spawn(move || {
                    let _connection = connection;
                    let _ = serve(stream, identity, handler, stop, permit);
                });
            } else {
                active.fetch_sub(1, Ordering::AcqRel);
            }
        } else {
            thread::sleep(Duration::from_millis(5));
        }
    }
}
fn serve(
    mut stream: UnixStream,
    identity: Identity,
    handler: Arc<CancellableHandler>,
    stop: Arc<AtomicBool>,
    permit: Permit,
) -> Result<()> {
    stream_options(&stream)?;
    let mut frames = Frames::new();
    let hello = frames.read(&mut stream, MAX_REQUEST, HANDSHAKE, &stop)?;
    let nonce = hello["nonce"]
        .as_str()
        .filter(|n| n.len() == 32)
        .ok_or_else(|| frame_error("SESSION_MISMATCH", "control handshake nonce is invalid"))?;
    if !matching_hello(&hello, &identity, nonce) {
        return Err(frame_error(
            "SESSION_MISMATCH",
            "control handshake did not match selected session",
        ));
    }
    write_frame(
        &mut stream,
        &hello_value(&identity, nonce)?,
        MAX_RESPONSE,
        &stop,
    )?;
    let request = frames.read(&mut stream, MAX_REQUEST, HANDSHAKE, &stop)?;
    let (id, command) = parse_request(request)?;
    // The request owns its cancellation token, never the owner's shared queue.
    // Permit follows the actual handler even after its caller has detached.
    let (sender, receiver) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let request_cancel = cancelled.clone();
    let deadline = request_deadline(&command.command);
    thread::spawn(move || {
        let _permit = permit;
        let result = handler(command, request_cancel);
        let _ = sender.send(result);
    });
    let result = await_handler(&stream, receiver, &stop, deadline);
    cancelled.store(true, Ordering::Release);
    send_result(&mut stream, &id, result, &stop)
}
fn await_handler(
    stream: &UnixStream,
    receiver: mpsc::Receiver<Result<Value>>,
    stop: &AtomicBool,
    budget: Duration,
) -> Result<Value> {
    let deadline = Instant::now() + budget;
    loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(frame_error("REQUEST_FAILED", "control request failed"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        detached(stop)?;
        if peer_closed(stream)? {
            return Err(frame_error(
                "REQUEST_ABORTED",
                "control request was detached",
            ));
        }
        if Instant::now() >= deadline {
            return Err(frame_error("REQUEST_TIMEOUT", "control request timed out"));
        }
    }
}
fn peer_closed(stream: &UnixStream) -> Result<bool> {
    let mut byte = 0u8;
    let count = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    if count >= 0 {
        return Ok(count == 0);
    }
    let error = std::io::Error::last_os_error();
    if transient(&error) {
        Ok(false)
    } else {
        Err(io(error))
    }
}
fn parse_request(frame: Value) -> Result<(String, Command)> {
    let id = frame["id"].as_str().filter(|id| id.len() <= 64);
    let command = frame["command"]
        .as_str()
        .filter(|c| !c.is_empty() && c.len() <= 100);
    if frame["type"] != "request" || id.is_none() || command.is_none() {
        return Err(frame_error("INVALID_COMMAND", "control request is invalid"));
    }
    Ok((
        id.unwrap().into(),
        Command {
            command: command.unwrap().into(),
            payload: frame["payload"].clone(),
        },
    ))
}
fn send_result(
    stream: &mut UnixStream,
    id: &str,
    result: Result<Value>,
    cancel: &AtomicBool,
) -> Result<()> {
    let response = match result {
        Ok(result) => json!({"type":"response","id":id,"ok":true,"result":result}),
        Err(error) => json!({"type":"response","id":id,"ok":false,"error":error}),
    };
    match write_frame(stream, &response, MAX_RESPONSE, cancel) {
        Err(error) if error.code == "RESPONSE_TOO_LARGE" => write_frame(
            stream,
            &json!({"type":"response","id":id,"ok":false,"error":{"code":"RESPONSE_TOO_LARGE","message":"control response exceeds byte limit"}}),
            MAX_RESPONSE,
            cancel,
        ),
        result => result,
    }
}
