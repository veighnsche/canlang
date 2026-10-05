//! Shared stdio LSP driver for integration tests: spawns the REAL `can lsp`
//! binary and speaks Content-Length JSON-RPC to it.
//!
//! Owned by B3 S4 (agent JSON + stale rejection); the authoring-join consumer
//! reuses this module as-is. Include it from an integration test with:
//!
//! ```ignore
//! #[path = "common/lsp_driver.rs"]
//! mod lsp_driver;
//! ```
//!
//! ## Contract
//!
//! * [`LspDriver::spawn`] locates the real binary via `CARGO_BIN_EXE_can`
//!   (set by Cargo for integration-test targets), falling back to
//!   `<manifest>/target/debug/can`.
//! * Every `request_*` helper assigns a fresh numeric id and reads until the
//!   response carrying that id arrives; interleaved server notifications
//!   (`textDocument/publishDiagnostics` after every message — the server
//!   pumps after each one) are buffered, never mistaken for responses.
//!   [`LspDriver::take_notifications`] returns the buffered bodies.
//! * Responses are returned as raw JSON-RPC body strings; tests assert on
//!   stable substrings (`"result":[]`, `"newText":"."`) like the in-process
//!   server tests do.
//! * [`LspDriver::shutdown`] performs `shutdown` → `exit` and reaps the
//!   child. `Drop` kills a still-running child so a failed test never hangs
//!   the suite on a orphaned server.

use canlang_compiler::diagnostic::push_json_str;
use canlang_compiler::lsp::transport as t;
use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};

/// A live `can lsp` child plus its framing state.
pub struct LspDriver {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    reader: BufReader<ChildStdout>,
    next_id: u64,
    notifications: Vec<String>,
}

impl LspDriver {
    /// Spawn the real `can lsp` binary (see module docs for discovery).
    pub fn spawn() -> io::Result<Self> {
        let path = option_env!("CARGO_BIN_EXE_can")
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/can"));
        Self::spawn_with(&path)
    }

    /// Spawn an explicit binary path as the LSP server.
    pub fn spawn_with(path: &std::path::Path) -> io::Result<Self> {
        let mut child = Command::new(path)
            .arg("lsp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin =
            BufWriter::new(child.stdin.take().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "lsp child has no stdin")
            })?);
        let reader =
            BufReader::new(child.stdout.take().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "lsp child has no stdout")
            })?);
        Ok(Self {
            child,
            stdin,
            reader,
            next_id: 1,
            notifications: Vec::new(),
        })
    }

    /// Send a request with `params_json` as the verbatim `params` value and
    /// return the matching response body (notifications skipped en route).
    pub fn request(&mut self, method: &str, params_json: &str) -> io::Result<String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut body = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":");
        push_json_str(&mut body, method);
        body.push_str(",\"params\":");
        body.push_str(params_json);
        body.push('}');
        t::write_message(&mut self.stdin, body.as_bytes())?;
        self.read_response(id)
    }

    /// Send a notification with `params_json` as the verbatim `params` value.
    pub fn notify(&mut self, method: &str, params_json: &str) -> io::Result<()> {
        let mut body = String::from("{\"jsonrpc\":\"2.0\",\"method\":");
        push_json_str(&mut body, method);
        body.push_str(",\"params\":");
        body.push_str(params_json);
        body.push('}');
        t::write_message(&mut self.stdin, body.as_bytes())
    }

    /// `initialize` + `initialized`: returns the initialize response body.
    pub fn initialize(&mut self) -> io::Result<String> {
        let response = self.request("initialize", "{}")?;
        self.notify("initialized", "{}")?;
        Ok(response)
    }

    /// `textDocument/didOpen` for `uri` at `version` holding `text`.
    pub fn did_open(&mut self, uri: &str, version: i32, text: &str) -> io::Result<()> {
        let mut params = String::from("{\"textDocument\":{\"uri\":");
        push_json_str(&mut params, uri);
        params.push_str(",\"languageId\":\"can\",\"version\":");
        params.push_str(&version.to_string());
        params.push_str(",\"text\":");
        push_json_str(&mut params, text);
        params.push_str("}}");
        self.notify("textDocument/didOpen", &params)
    }

    /// `textDocument/didChange` replacing the whole document with `text`.
    pub fn did_change(&mut self, uri: &str, version: i32, text: &str) -> io::Result<()> {
        let mut params = String::from("{\"textDocument\":{\"uri\":");
        push_json_str(&mut params, uri);
        params.push_str(",\"version\":");
        params.push_str(&version.to_string());
        params.push_str("},\"contentChanges\":[{\"text\":");
        push_json_str(&mut params, text);
        params.push_str("}]}");
        self.notify("textDocument/didChange", &params)
    }

    /// `textDocument/codeAction` for the `(line, character)` range in `uri`;
    /// returns the response body.
    pub fn code_action(
        &mut self,
        uri: &str,
        start: (u32, u32),
        end: (u32, u32),
    ) -> io::Result<String> {
        let mut params = String::from("{\"textDocument\":{\"uri\":");
        push_json_str(&mut params, uri);
        params.push_str("},\"range\":");
        params.push_str(&range_json(start, end));
        params.push('}');
        self.request("textDocument/codeAction", &params)
    }

    /// `textDocument/rename` at `position` to `new_name`; returns the body.
    pub fn rename(
        &mut self,
        uri: &str,
        line: u32,
        character: u32,
        new_name: &str,
    ) -> io::Result<String> {
        let mut params = String::from("{\"textDocument\":{\"uri\":");
        push_json_str(&mut params, uri);
        params.push_str("},\"position\":");
        params.push_str(&position_json(line, character));
        params.push_str(",\"newName\":");
        push_json_str(&mut params, new_name);
        params.push('}');
        self.request("textDocument/rename", &params)
    }

    /// `textDocument/completion` at `position`; returns the response body.
    pub fn completion(&mut self, uri: &str, line: u32, character: u32) -> io::Result<String> {
        let mut params = String::from("{\"textDocument\":{\"uri\":");
        push_json_str(&mut params, uri);
        params.push_str("},\"position\":");
        params.push_str(&position_json(line, character));
        params.push('}');
        self.request("textDocument/completion", &params)
    }

    /// Take the notification bodies buffered while awaiting responses.
    pub fn take_notifications(&mut self) -> Vec<String> {
        std::mem::take(&mut self.notifications)
    }

    /// `shutdown` → `exit`, then reap the child and return its status.
    pub fn shutdown(&mut self) -> io::Result<ExitStatus> {
        let response = self.request("shutdown", "{}")?;
        if !response.contains("\"result\":null") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("shutdown refused: {response}"),
            ));
        }
        self.notify("exit", "{}")?;
        self.child.wait()
    }

    /// Read framed bodies until the response with numeric `id` arrives,
    /// buffering notifications aside.
    fn read_response(&mut self, id: u64) -> io::Result<String> {
        loop {
            let body = t::read_message(&mut self.reader)?.ok_or_else(|| {
                io::Error::new(io::ErrorKind::UnexpectedEof, "lsp server closed stdout")
            })?;
            let text = String::from_utf8_lossy(&body).into_owned();
            if response_id(&text) == Some(id) {
                return Ok(text);
            }
            self.notifications.push(text);
        }
    }
}

impl Drop for LspDriver {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn position_json(line: u32, character: u32) -> String {
    format!("{{\"line\":{line},\"character\":{character}}}")
}

fn range_json(start: (u32, u32), end: (u32, u32)) -> String {
    format!(
        "{{\"start\":{},\"end\":{}}}",
        position_json(start.0, start.1),
        position_json(end.0, end.1)
    )
}

/// Numeric response `id` of a JSON-RPC body, or `None` for notifications
/// and error-shaped frames. Parses with the crate JSON model (dependency
/// free) instead of substring matching.
fn response_id(body: &str) -> Option<u64> {
    let value = t::parse(body).ok()?;
    match value.get("id")? {
        t::Json::Num(lexeme) => lexeme.parse().ok(),
        _ => None,
    }
}
