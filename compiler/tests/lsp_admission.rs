//! Admission witnesses through the shipped `can lsp` stdio process.
//!
//! Keep raw request bytes here: framing must consume the original body even
//! when its encoding is invalid. Gated envelope/ID/params policies belong in
//! later witnesses once their decisions are accepted.

use canlang_compiler::lsp::transport::{self, Json};
use std::io::{self, Cursor, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: u64 = 1024 * 1024;
const INITIALIZE_PARAMS: &str = r#"{"processId":null,"rootUri":null,"capabilities":{}}"#;

/// Kill and reap on timeout, assertion failure, or any other early return.
struct ReapChild(Child);

impl Drop for ReapChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Transcript {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Transcript {
    fn assert_exit(&self, code: i32) {
        assert_eq!(
            self.status.code(),
            Some(code),
            "stderr: {}",
            String::from_utf8_lossy(&self.stderr)
        );
        assert!(
            !String::from_utf8_lossy(&self.stderr).contains("panicked"),
            "server panic: {:?}",
            self.stderr
        );
    }

    fn responses(&self) -> Vec<Json> {
        let mut reader = Cursor::new(&self.stdout);
        let mut responses = Vec::new();
        while let Some(body) = transport::read_message(&mut reader)
            .expect("server output must have complete Content-Length framing")
        {
            let text = std::str::from_utf8(&body).expect("response body must be UTF-8");
            let value = transport::parse(text).expect("response body must be JSON");
            assert_eq!(value.get("jsonrpc").and_then(Json::as_str), Some("2.0"));
            responses.push(value);
        }
        responses
    }
}

fn capture(reader: impl Read + Send + 'static) -> Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = reader.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes);
        let result = result.and_then(|_| {
            if bytes.len() as u64 > OUTPUT_LIMIT {
                Err(io::Error::other("LSP process exceeded test output budget"))
            } else {
                Ok(bytes)
            }
        });
        let _ = sender.send(result);
    });
    receiver
}

fn receive<T>(receiver: Receiver<io::Result<T>>, deadline: Instant, label: &str) -> T {
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .unwrap_or_else(|error| {
            panic!("can lsp {label} did not finish within {TIMEOUT:?}: {error}")
        })
        .unwrap_or_else(|error| panic!("can lsp {label}: {error}"))
}

/// Send a finite byte transcript, close stdin, and collect all output. Pipe
/// reads and writes run concurrently so a blocked pipe cannot evade the
/// deadline; the guard kills and reaps the child if any step times out.
fn run(input: Vec<u8>) -> Transcript {
    let deadline = Instant::now() + TIMEOUT;
    let mut child = ReapChild(
        Command::new(env!("CARGO_BIN_EXE_can"))
            .arg("lsp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn real can lsp"),
    );
    let mut stdin = child.0.stdin.take().expect("child stdin");
    let stdout = capture(child.0.stdout.take().expect("child stdout"));
    let stderr = capture(child.0.stderr.take().expect("child stderr"));
    let (sender, written) = mpsc::channel();
    thread::spawn(move || {
        let result = stdin.write_all(&input);
        drop(stdin);
        let _ = sender.send(result);
    });
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("poll can lsp") {
            break status;
        }
        assert!(Instant::now() < deadline, "can lsp exceeded {TIMEOUT:?}");
        thread::sleep(Duration::from_millis(10));
    };
    receive(written, deadline, "stdin writer");
    Transcript {
        status,
        stdout: receive(stdout, deadline, "stdout reader"),
        stderr: receive(stderr, deadline, "stderr reader"),
    }
}

fn frame(body: &[u8]) -> Vec<u8> {
    let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn initialize(id_json: &str) -> Vec<u8> {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id_json},\"method\":\"initialize\",\"params\":{INITIALIZE_PARAMS}}}"
    )
    .into_bytes()
}

fn assert_success(response: &Json) {
    assert!(response.get("result").is_some(), "{response:?}");
    assert!(response.get("error").is_none(), "{response:?}");
}

/// Assert the original number spelling without floating point conversion.
fn assert_number_id(response: &Json, expected: &str) {
    match response.get("id") {
        Some(Json::Num(lexeme)) => assert_eq!(lexeme, expected),
        id => panic!("expected numeric ID {expected}, got {id:?}"),
    }
}

#[test]
fn malformed_utf8_is_one_parse_error_and_does_not_initialize() {
    let cases: [(&str, &[u8]); 6] = [
        ("invalid leading byte", &[0xff]),
        ("isolated continuation", &[0x80]),
        ("overlong encoding", &[0xc0, 0xaf]),
        ("encoded surrogate", &[0xed, 0xa0, 0x80]),
        ("above Unicode maximum", &[0xf4, 0x90, 0x80, 0x80]),
        ("truncated sequence", &[0xe2, 0x82]),
    ];
    for (label, invalid) in cases {
        // Except for UTF-8, this is a complete initialize request: lossy
        // replacement would turn it into an executable request.
        let mut malformed = br#"{"jsonrpc":"2.0","id":"bad-"#.to_vec();
        malformed.extend_from_slice(invalid);
        malformed.extend_from_slice(
            format!("\",\"method\":\"initialize\",\"params\":{INITIALIZE_PARAMS}}}").as_bytes(),
        );
        assert!(std::str::from_utf8(&malformed).is_err(), "{label}");
        let mut input = frame(&malformed);
        input.extend(frame(&initialize(r#""recovered""#)));
        let output = run(input);
        output.assert_exit(0);
        let responses = output.responses();
        assert_eq!(responses.len(), 2, "{label}: {responses:?}");
        assert_eq!(responses[0].get("id"), Some(&Json::Null), "{label}");
        assert_eq!(
            responses[0]
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Json::as_i64),
            Some(-32700),
            "{label}: {:?}",
            responses[0]
        );
        assert!(responses[0].get("result").is_none(), "{label}");
        assert_eq!(
            responses[1].get("id").and_then(Json::as_str),
            Some("recovered")
        );
        assert_success(&responses[1]);
    }
}

#[test]
fn valid_unicode_string_id_keeps_its_semantic_value() {
    let output = run(frame(&initialize(r#""é😀-\u0061-\"-\\-\n""#)));
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(responses.len(), 1);
    assert_success(&responses[0]);
    assert_eq!(
        responses[0].get("id").and_then(Json::as_str),
        Some("é😀-a-\"-\\-\n")
    );
}

#[test]
fn eof_keeps_the_existing_clean_disconnect_exit() {
    let output = run(Vec::new());
    output.assert_exit(0);
    assert!(output.stdout.is_empty());
}

#[test]
fn torn_headers_and_body_keep_the_existing_clean_disconnect_exit() {
    for input in [
        b"Content-Length: 100\r\n".to_vec(),
        b"Content-Length: 100\r\n\r\n{\"jsonrpc\":\"2.0\"".to_vec(),
    ] {
        let output = run(input);
        output.assert_exit(0);
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn shutdown_then_exit_is_clean() {
    let mut input = frame(&initialize("1"));
    for body in [
        br#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#.as_slice(),
        br#"{"jsonrpc":"2.0","id":2,"method":"shutdown"}"#.as_slice(),
        br#"{"jsonrpc":"2.0","method":"exit"}"#.as_slice(),
    ] {
        input.extend(frame(body));
    }
    let output = run(input);
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(responses.len(), 2);
    assert_number_id(&responses[0], "1");
    assert_success(&responses[0]);
    assert_number_id(&responses[1], "2");
    assert_success(&responses[1]);
    assert_eq!(responses[1].get("result"), Some(&Json::Null));
}

#[test]
fn exit_before_shutdown_has_exit_code_one() {
    let output = run(frame(br#"{"jsonrpc":"2.0","method":"exit"}"#));
    output.assert_exit(1);
    assert!(output.stdout.is_empty());
}
