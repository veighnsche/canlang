//! Admission witnesses through the shipped `can lsp` stdio process.
//!
//! Keep raw request bytes here: framing must consume the original body even
//! when its encoding is invalid. Expected outcomes below freeze the accepted
//! envelope, ID, parameter, and lifecycle admission decisions.

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

fn call(id: Option<&str>, method: &str, params: Option<&str>) -> Vec<u8> {
    let id = id.map(|id| format!(",\"id\":{id}")).unwrap_or_default();
    let params = params
        .map(|params| format!(",\"params\":{params}"))
        .unwrap_or_default();
    format!("{{\"jsonrpc\":\"2.0\"{id},\"method\":\"{method}\"{params}}}").into_bytes()
}

fn messages(bodies: impl IntoIterator<Item = Vec<u8>>) -> Transcript {
    run(bodies.into_iter().flat_map(|body| frame(&body)).collect())
}

fn assert_error(response: &Json, code: i64, id_json: &str) {
    assert_eq!(
        response.get("id"),
        Some(&transport::parse(id_json).expect("expected ID JSON"))
    );
    assert_eq!(
        response
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Json::as_i64),
        Some(code),
        "{response:?}"
    );
    assert!(response.get("result").is_none(), "{response:?}");
}

/// A successful second initialize proves the rejected first message neither
/// dispatched nor poisoned lifecycle state, as well as checking frame count.
fn rejected_then_initialize(body: Vec<u8>, code: i64, id_json: &str) {
    let output = messages([body, initialize("99")]);
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(responses.len(), 2, "{responses:?}");
    assert_error(&responses[0], code, id_json);
    assert_number_id(&responses[1], "99");
    assert_success(&responses[1]);
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

#[test]
fn accepted_integral_ids_preserve_the_original_number_lexeme() {
    for id in [
        "-2147483648",
        "2147483647",
        "-0",
        "1.0",
        "1e0",
        "1E+0",
        "-0E-999999999999999999999",
        "0.1e1",
        "1000e-3",
        "2.147483647e9",
        "-2.147483648e9",
        "0e999999999999999999999",
        "21474836470e-1",
    ] {
        let output = messages([initialize(id)]);
        output.assert_exit(0);
        let responses = output.responses();
        assert_eq!(responses.len(), 1, "ID {id}: {responses:?}");
        assert_success(&responses[0]);
        assert_number_id(&responses[0], id);
    }
}

#[test]
fn illegal_ids_are_null_correlated_and_never_initialize() {
    for id in [
        "true",
        "null",
        "{}",
        "[]",
        "1.5",
        "1.0000000000000000001",
        "2147483648",
        "-2147483649",
        "1e-1000",
        "1e-999999999999999999999",
        "21474836480e-1",
    ] {
        rejected_then_initialize(initialize(id), -32600, "null");
    }
}

#[test]
fn malformed_envelopes_correlate_only_a_unique_legal_id() {
    for (body, id) in [
        (r#"{"id":7,"method":"initialize","params":{}}"#, "7"),
        (
            r#"{"jsonrpc":"1.0","id":7,"method":"initialize","params":{}}"#,
            "7",
        ),
        (
            r#"{"jsonrpc":2,"id":7,"method":"initialize","params":{}}"#,
            "7",
        ),
        (
            r#"{"jsonrpc":"2.0","id":"readable","method":false}"#,
            r#""readable""#,
        ),
        (r#"{"jsonrpc":"2.0","id":7,"params":{}}"#, "7"),
        (
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":false}"#,
            "7",
        ),
        (
            r#"{"jsonrpc":"2.0","method":"initialize","params":false}"#,
            "null",
        ),
        (r#"{"jsonrpc":"2.0","id":false,"method":false}"#, "null"),
        (r#"{"method":"initialize"}"#, "null"),
        (r#"{"jsonrpc":"2.0","method":4}"#, "null"),
        ("[]", "null"),
        ("null", "null"),
        ("42", "null"),
    ] {
        rejected_then_initialize(body.as_bytes().to_vec(), -32600, id);
    }
}

#[test]
fn decoded_reserved_duplicate_keys_are_rejected_before_dispatch() {
    for (body, id) in [
        (
            r#"{"jsonrpc":"2.0","jsonrpc":"2.0","id":7,"method":"initialize"}"#,
            "7",
        ),
        (
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize","metho\u0064":"initialize"}"#,
            "7",
        ),
        (
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{},"para\u006ds":{}}"#,
            "7",
        ),
        (
            r#"{"jsonrpc":"2.0","id":7,"i\u0064":7,"method":"initialize"}"#,
            "null",
        ),
        (r#"{"jsonrpc":"1.0","id":7,"id":8,"method":false}"#, "null"),
        (
            r#"{"jsonrpc":"2.0","method":"initialize","method":"initialize"}"#,
            "null",
        ),
    ] {
        rejected_then_initialize(body.as_bytes().to_vec(), -32600, id);
    }
}

#[test]
fn malformed_json_is_a_null_parse_error_and_consumes_the_frame() {
    for body in [
        r#"{"jsonrpc":"2.0","id":7,"method":"initialize",}"#,
        r#"{"jsonrpc":"2.0","id":7,"method":"initialize"} trailing"#,
        r#"{"jsonrpc":"2.0","id":"\uD800","method":"initialize"}"#,
    ] {
        rejected_then_initialize(body.as_bytes().to_vec(), -32700, "null");
    }
}

#[test]
fn invalid_initialize_fields_do_not_initialize() {
    for params in [
        "{}",
        "[]",
        r#"{"processId":null,"rootUri":null}"#,
        r#"{"processId":true,"rootUri":null,"capabilities":{}}"#,
        r#"{"processId":2147483648,"rootUri":null,"capabilities":{}}"#,
        r#"{"processId":null,"rootUri":false,"capabilities":{}}"#,
        r#"{"processId":null,"rootUri":null,"capabilities":[]}"#,
    ] {
        rejected_then_initialize(call(Some("7"), "initialize", Some(params)), -32602, "7");
    }
    rejected_then_initialize(call(Some("7"), "initialize", None), -32602, "7");
    rejected_then_initialize(call(Some("7"), "initialize", Some("null")), -32600, "7");
}

#[test]
fn initialize_admits_unknown_capabilities_and_extensions() {
    let output = messages([call(
        Some("7"),
        "initialize",
        Some(
            r#"{"processId":123,"rootUri":"file:///workspace","capabilities":{"experimental":{"future":true}},"futureOption":[1,2]}"#,
        ),
    )]);
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(responses.len(), 1);
    assert_number_id(&responses[0], "7");
    assert_success(&responses[0]);
}

#[test]
fn lifecycle_precedence_is_envelope_then_lifecycle_then_method_then_params() {
    let output = messages([
        call(Some("1"), "textDocument/hover", Some("{}")),
        call(Some("2"), "future/unknown", Some("{}")),
        call(Some("3"), "textDocument/hover", Some("false")),
        initialize("4"),
        call(Some("5"), "future/unknown", Some("[]")),
        call(Some("6"), "future/unknown", Some("false")),
        call(Some("7"), "shutdown", None),
        call(Some("8"), "textDocument/hover", Some("{}")),
        call(Some("9"), "future/unknown", Some("[]")),
        call(Some("10"), "textDocument/hover", Some("false")),
        call(None, "exit", None),
    ]);
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(responses.len(), 10, "{responses:?}");
    for (index, code, id) in [
        (0, -32002, "1"),
        (1, -32002, "2"),
        (2, -32600, "3"),
        (4, -32601, "5"),
        (5, -32600, "6"),
        (7, -32600, "8"),
        (8, -32600, "9"),
        (9, -32600, "10"),
    ] {
        assert_error(&responses[index], code, id);
    }
    assert_success(&responses[3]);
    assert_success(&responses[6]);
}

#[test]
fn shutdown_and_exit_accept_absent_null_and_empty_object_params() {
    for params in [None, Some("null"), Some("{}")] {
        let output = messages([
            initialize("1"),
            call(Some("2"), "shutdown", params),
            call(None, "exit", params),
        ]);
        output.assert_exit(0);
        let responses = output.responses();
        assert_eq!(responses.len(), 2);
        assert_success(&responses[0]);
        assert_success(&responses[1]);
        assert_eq!(responses[1].get("result"), Some(&Json::Null));
    }
}

#[test]
fn invalid_shutdown_and_exit_params_do_not_change_lifecycle() {
    for params in [r#"{"unexpected":true}"#, "[]"] {
        let output = messages([
            initialize("1"),
            call(Some("2"), "shutdown", Some(params)),
            call(None, "exit", Some(params)),
            call(Some("3"), "future/unknown", Some("{}")),
            call(Some("4"), "shutdown", None),
            call(None, "exit", None),
        ]);
        output.assert_exit(0);
        let responses = output.responses();
        assert_eq!(responses.len(), 4, "{responses:?}");
        assert_success(&responses[0]);
        assert_error(&responses[1], -32602, "2");
        assert_error(&responses[2], -32601, "3");
        assert_success(&responses[3]);
    }
}

const DOC_PARAMS: &str = r#"{"textDocument":{"uri":"file:///admission.can"}}"#;
const OPEN_PARAMS: &str = r#"{"textDocument":{"uri":"file:///admission.can","languageId":"can","version":1,"text":"app Admission\n"}}"#;

#[test]
fn notifications_outside_ready_cannot_open_documents_or_publish() {
    let output = messages([
        call(None, "textDocument/didOpen", Some(OPEN_PARAMS)),
        initialize("1"),
        call(
            Some("2"),
            "textDocument/semanticTokens/full",
            Some(DOC_PARAMS),
        ),
        call(Some("3"), "shutdown", None),
        call(None, "textDocument/didOpen", Some(OPEN_PARAMS)),
        call(
            None,
            "textDocument/didChange",
            Some(
                r#"{"textDocument":{"uri":"file:///admission.can","version":2},"contentChanges":[{"text":"app Changed\n"}]}"#,
            ),
        ),
        call(None, "exit", None),
    ]);
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(
        responses.len(),
        3,
        "notifications must not publish: {responses:?}"
    );
    assert_success(&responses[0]);
    assert_error(&responses[1], -32602, "2");
    assert_success(&responses[2]);
}

#[test]
fn malformed_did_open_is_silent_and_does_not_create_a_document() {
    for params in [
        r#"{"textDocument":{"uri":"file:///admission.can","version":1,"text":"app Admission\n"}}"#,
        r#"{"textDocument":{"uri":"file:///admission.can","languageId":"can","version":2147483648,"text":"app Admission\n"}}"#,
        r#"{"textDocument":{"uri":"file:///admission.can","languageId":"can","version":1,"text":false}}"#,
    ] {
        let output = messages([
            initialize("1"),
            call(None, "textDocument/didOpen", Some(params)),
            call(
                Some("2"),
                "textDocument/semanticTokens/full",
                Some(DOC_PARAMS),
            ),
        ]);
        output.assert_exit(0);
        let responses = output.responses();
        assert_eq!(responses.len(), 2, "{responses:?}");
        assert_success(&responses[0]);
        assert_error(&responses[1], -32602, "2");
    }
}

#[test]
fn malformed_did_change_does_not_mutate_or_publish_a_new_version() {
    for params in [
        r#"{"textDocument":{"uri":"file:///admission.can"},"contentChanges":[{"text":"app Changed\n"}]}"#,
        r#"{"textDocument":{"uri":"file:///admission.can","version":2147483648},"contentChanges":[{"text":"app Changed\n"}]}"#,
        r#"{"textDocument":{"uri":"file:///admission.can","version":2},"contentChanges":{}}"#,
        r#"{"textDocument":{"uri":"file:///admission.can","version":2},"contentChanges":[{"text":"app Changed\n"},{"text":false}]}"#,
        r#"{"textDocument":{"uri":"file:///admission.can","version":2},"contentChanges":[{"text":"app Changed\n"},{"text":"x","range":{"start":{"line":0,"character":0},"end":{"line":2147483648,"character":0}}}]}"#,
    ] {
        let output = messages([
            initialize("1"),
            call(None, "textDocument/didOpen", Some(OPEN_PARAMS)),
            call(None, "textDocument/didChange", Some(params)),
            call(
                Some("2"),
                "textDocument/semanticTokens/full",
                Some(DOC_PARAMS),
            ),
        ]);
        output.assert_exit(0);
        let frames = output.responses();
        assert_eq!(frames.len(), 3, "{frames:?}");
        assert_success(&frames[0]);
        assert_eq!(
            frames[1].get("method").and_then(Json::as_str),
            Some("textDocument/publishDiagnostics")
        );
        assert_eq!(
            frames[1]
                .get("params")
                .and_then(|p| p.get("version"))
                .and_then(Json::as_i64),
            Some(1)
        );
        assert_number_id(&frames[2], "2");
        assert_success(&frames[2]);
    }
}

#[test]
fn known_method_field_errors_reply_to_requests_and_leave_notifications_silent() {
    for (method, params) in [
        (
            "textDocument/hover",
            r#"{"textDocument":{"uri":"file:///admission.can"},"position":{"line":2147483648,"character":0}}"#,
        ),
        (
            "textDocument/references",
            r#"{"textDocument":{"uri":"file:///admission.can"},"position":{"line":0,"character":0},"context":{}}"#,
        ),
        (
            "textDocument/codeAction",
            r#"{"textDocument":{"uri":"file:///admission.can"},"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"context":{"diagnostics":false}}"#,
        ),
        (
            "textDocument/rename",
            r#"{"textDocument":{"uri":"file:///admission.can"},"position":{"line":0,"character":0},"newName":false}"#,
        ),
    ] {
        let output = messages([
            initialize("1"),
            call(None, "textDocument/didOpen", Some(OPEN_PARAMS)),
            call(Some("2"), method, Some(params)),
            call(None, method, Some(params)),
            call(None, "initialized", Some("[]")),
            call(Some("3"), "shutdown", None),
            call(None, "exit", None),
        ]);
        output.assert_exit(0);
        let frames = output.responses();
        assert_eq!(frames.len(), 4, "{method}: {frames:?}");
        assert_success(&frames[0]);
        assert_eq!(
            frames[1].get("method").and_then(Json::as_str),
            Some("textDocument/publishDiagnostics")
        );
        assert_error(&frames[2], -32602, "2");
        assert_success(&frames[3]);
    }
}

#[test]
fn valid_notification_envelopes_are_silent_without_initializing() {
    let output = messages([
        call(None, "initialize", Some(INITIALIZE_PARAMS)),
        call(None, "future/unknown", Some("{}")),
        initialize("1"),
        call(None, "initialized", Some("{}")),
        call(None, "future/unknown", Some("[]")),
        call(Some("2"), "shutdown", None),
        call(None, "exit", None),
    ]);
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(responses.len(), 2, "{responses:?}");
    assert_success(&responses[0]);
    assert_success(&responses[1]);
}

#[test]
fn valid_required_contexts_and_maximum_position_are_admitted() {
    let output = messages([
        initialize("1"),
        call(None, "textDocument/didOpen", Some(OPEN_PARAMS)),
        call(
            Some("2"),
            "textDocument/references",
            Some(
                r#"{"textDocument":{"uri":"file:///admission.can"},"position":{"line":0,"character":0},"context":{"includeDeclaration":true}}"#,
            ),
        ),
        call(
            Some("3"),
            "textDocument/codeAction",
            Some(
                r#"{"textDocument":{"uri":"file:///admission.can"},"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"context":{"diagnostics":[]}}"#,
            ),
        ),
        call(
            Some("4"),
            "textDocument/hover",
            Some(
                r#"{"textDocument":{"uri":"file:///admission.can"},"position":{"line":2147483647,"character":2147483647}}"#,
            ),
        ),
    ]);
    output.assert_exit(0);
    let frames = output.responses();
    assert_eq!(frames.len(), 5, "{frames:?}");
    for index in [0, 2, 3, 4] {
        assert_success(&frames[index]);
    }
    assert_eq!(frames[4].get("result"), Some(&Json::Null));
}

#[test]
fn primitive_shutdown_and_exit_params_are_envelope_errors() {
    let output = messages([
        initialize("1"),
        call(Some("2"), "shutdown", Some("false")),
        call(None, "exit", Some("false")),
        call(Some("3"), "future/unknown", Some("{}")),
        call(Some("4"), "shutdown", None),
        call(None, "exit", None),
    ]);
    output.assert_exit(0);
    let responses = output.responses();
    assert_eq!(responses.len(), 5, "{responses:?}");
    assert_success(&responses[0]);
    assert_error(&responses[1], -32600, "2");
    assert_error(&responses[2], -32600, "null");
    assert_error(&responses[3], -32601, "3");
    assert_success(&responses[4]);
}
