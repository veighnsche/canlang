//! Independent wire witnesses for the typed output migration. The real shipped
//! process handles CRLF buffers, UTF-16 positions, versions, and opaque URI keys.
//! Expected values use manual scalar counting and fixed protocol values; neither
//! production DTO serializers nor the production LineIndex construct the oracle.

use serde_json::{Value, json};
use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: u64 = 2 * 1024 * 1024;
const CAPABILITY_FIXTURE: &str = include_str!("../../editors/vscode/test/lsp-capabilities.can");
const ACTION_FIXTURE: &str = include_str!("../../editors/vscode/test/lsp-codeaction.can");

struct Reap(Child);
impl Drop for Reap {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn capture(reader: impl Read + Send + 'static) -> Receiver<io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = reader
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .and_then(|_| {
                if bytes.len() as u64 <= OUTPUT_LIMIT {
                    Ok(bytes)
                } else {
                    Err(io::Error::other("output budget exceeded"))
                }
            });
        let _ = tx.send(result);
    });
    rx
}

fn receive<T>(rx: Receiver<io::Result<T>>, deadline: Instant) -> T {
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .expect("real LSP pipe timed out")
        .expect("real LSP pipe failed")
}

/// A finite session bounds writes, reads, and process exit. Independent framing
/// parsing below also checks every emitted body's byte length and UTF-8 validity.
fn session(messages: Vec<Value>) -> Vec<Value> {
    let deadline = Instant::now() + TIMEOUT;
    let mut child = Reap(
        Command::new(env!("CARGO_BIN_EXE_can"))
            .arg("lsp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn fresh Cargo can binary"),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    let stdout = capture(child.0.stdout.take().unwrap());
    let stderr = capture(child.0.stderr.take().unwrap());
    let mut input = Vec::new();
    for message in messages {
        let body = serde_json::to_vec(&message).unwrap();
        input.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
        input.extend_from_slice(&body);
    }
    let (tx, written) = mpsc::channel();
    thread::spawn(move || {
        let result = stdin.write_all(&input);
        drop(stdin);
        let _ = tx.send(result);
    });
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "real LSP process exceeded {TIMEOUT:?}"
        );
        thread::sleep(Duration::from_millis(10));
    };
    receive(written, deadline);
    let stdout = receive(stdout, deadline);
    let stderr = receive(stderr, deadline);
    assert_eq!(
        status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&stderr)
    );
    assert!(!String::from_utf8_lossy(&stderr).contains("panicked"));
    let mut remaining = stdout.as_slice();
    let mut frames = Vec::new();
    while !remaining.is_empty() {
        let end = remaining
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("complete output frame header");
        let header = std::str::from_utf8(&remaining[..end]).unwrap();
        let length: usize = header
            .strip_prefix("Content-Length: ")
            .expect("Content-Length output header")
            .parse()
            .unwrap();
        remaining = &remaining[end + 4..];
        assert!(remaining.len() >= length, "complete output body");
        let raw = std::str::from_utf8(&remaining[..length]).expect("strict UTF-8 output");
        let value: Value = serde_json::from_str(raw).expect("independent output JSON parse");
        assert_eq!(value["jsonrpc"], "2.0");
        frames.push(value);
        remaining = &remaining[length..];
    }
    frames
}

fn request(id: u32, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
}
fn notify(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0", "method":method, "params":params})
}
fn start() -> Vec<Value> {
    vec![
        request(
            1,
            "initialize",
            json!({"processId":null,"rootUri":null,"capabilities":{}}),
        ),
        notify("initialized", json!({})),
    ]
}
fn finish(messages: &mut Vec<Value>) {
    messages.push(request(99, "shutdown", Value::Null));
    messages.push(notify("exit", Value::Null));
}
fn open(uri: &str, version: i32, text: &str) -> Value {
    notify(
        "textDocument/didOpen",
        json!({"textDocument":{
        "uri":uri,"languageId":"can","version":version,"text":text}}),
    )
}
fn change(uri: &str, version: i32, text: &str) -> Value {
    notify(
        "textDocument/didChange",
        json!({"textDocument":{"uri":uri,"version":version},
        "contentChanges":[{"text":text}]}),
    )
}
fn doc(uri: &str) -> Value {
    json!({"textDocument":{"uri":uri}})
}
fn at(uri: &str, position: Value) -> Value {
    json!({"textDocument":{"uri":uri},"position":position})
}
fn response(frames: &[Value], id: u32) -> &Value {
    let matching: Vec<_> = frames
        .iter()
        .filter(|f| f.get("id") == Some(&json!(id)))
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "one routed response for {id}: {frames:#?}"
    );
    let frame = matching[0];
    assert!(frame.get("error").is_none(), "request {id}: {frame:#?}");
    frame
        .get("result")
        .expect("result present, including explicit null")
}
fn diagnostics<'a>(frames: &'a [Value], uri: &str, version: i32) -> &'a Value {
    let matching: Vec<_> = frames
        .iter()
        .filter(|f| {
            f["method"] == "textDocument/publishDiagnostics"
                && f["params"]["uri"] == uri
                && f["params"]["version"] == version
        })
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "one diagnostic publication for {uri}@{version}: {frames:#?}"
    );
    &matching[0]["params"]["diagnostics"]
}

/// Count Unicode scalars independently: supplementary scalars contribute two
/// units. CRLF increments the line once and does not affect the next column.
fn position(text: &str, byte: usize) -> Value {
    let mut line = 0;
    let mut character = 0;
    for scalar in text[..byte].chars() {
        if scalar == '\n' {
            line += 1;
            character = 0;
        } else {
            character += if scalar as u32 > 0xffff { 2 } else { 1 };
        }
    }
    json!({"line":line,"character":character})
}
fn span(text: &str, needle: &str, occurrence: usize) -> Value {
    let byte = text
        .match_indices(needle)
        .nth(occurrence)
        .expect("fixture anchor")
        .0;
    json!({"start":position(text, byte),"end":position(text, byte + needle.len())})
}
fn capability_text() -> String {
    CAPABILITY_FIXTURE
        .replace("let label=task.title", "let label=\"😀\"+task.title")
        .replace('\n', "\r\n")
}
fn action_text() -> String {
    ACTION_FIXTURE
        .replace("let x=m?.n", "let x=\"😀\"+m?.n")
        .replace('\n', "\r\n")
}
fn rename_params(uri: &str, text: &str, needle: &str) -> Value {
    let byte = text.find(needle).unwrap();
    let mut params = at(uri, position(text, byte));
    params["newName"] = json!("job");
    params
}
fn action_params(uri: &str, text: &str) -> Value {
    json!({"textDocument":{"uri":uri},"range":span(text,"?.",0),"context":{"diagnostics":[]}})
}
fn assert_document_edit(edit: &Value, uri: &str, version: i32, expected: Value) {
    assert_eq!(edit["documentChanges"].as_array().unwrap().len(), 1);
    let change = &edit["documentChanges"][0];
    assert_eq!(change["textDocument"], json!({"uri":uri,"version":version}));
    assert_eq!(change["edits"], expected);
}
fn expected_rename(text: &str, name: &str) -> Value {
    json!([{"range":span(text,name,0),"newText":"job"},
           {"range":span(text,name,1),"newText":"job"}])
}
fn assert_action(actions: &Value, uri: &str, version: i32, text: &str) {
    let fixes: Vec<_> = actions
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["title"] == "replace redundant `?.` with `.`")
        .collect();
    assert_eq!(fixes.len(), 1, "{actions:#?}");
    assert_eq!(fixes[0]["kind"], "quickfix");
    assert_document_edit(
        &fixes[0]["edit"],
        uri,
        version,
        json!([{"range":span(text,"?.",0),"newText":"."}]),
    );
}

#[test]
fn real_all_output_families_crlf_and_supplementary_utf16() {
    let uri = "file:///typed-output%2fCAP.can";
    let action_uri = "file:///typed-output%2fACTION.can";
    let text = capability_text();
    let action = action_text();
    // Freeze the authored independent counts to expose accidental byte counting.
    assert_eq!(
        span(&text, "task", 1),
        json!({"start":{"line":6,"character":18},"end":{"line":6,"character":22}})
    );
    assert_eq!(
        span(&action, "?.", 0),
        json!({"start":{"line":6,"character":15},"end":{"line":6,"character":17}})
    );
    let mut input = start();
    input.push(open(uri, 7, &text));
    input.push(open(action_uri, 7, &action));
    input.push(request(
        2,
        "textDocument/hover",
        at(uri, span(&text, "task", 1)["start"].clone()),
    ));
    input.push(request(
        3,
        "textDocument/completion",
        at(uri, span(&text, "task", 1)["start"].clone()),
    ));
    input.push(request(
        4,
        "textDocument/definition",
        at(uri, span(&text, "task", 1)["start"].clone()),
    ));
    let mut refs = at(uri, span(&text, "task", 0)["start"].clone());
    refs["context"] = json!({"includeDeclaration":true});
    input.push(request(5, "textDocument/references", refs));
    input.push(request(
        6,
        "textDocument/rename",
        rename_params(uri, &text, "task.title"),
    ));
    input.push(request(7, "textDocument/semanticTokens/full", doc(uri)));
    input.push(request(
        8,
        "textDocument/codeAction",
        action_params(action_uri, &action),
    ));
    finish(&mut input);
    let frames = session(input);
    assert_eq!(
        frames.len(),
        11,
        "all responses plus two buffered diagnostics: {frames:#?}"
    );
    let caps = &response(&frames, 1)["capabilities"];
    assert_eq!(caps["positionEncoding"], "utf-16");
    assert_eq!(caps["textDocumentSync"], 1);
    for key in [
        "hoverProvider",
        "definitionProvider",
        "referencesProvider",
        "renameProvider",
        "codeActionProvider",
    ] {
        assert_eq!(caps[key], true, "{key}");
    }
    assert!(caps["completionProvider"].is_object());
    assert_eq!(caps["semanticTokensProvider"]["full"], true);
    assert_eq!(
        caps["semanticTokensProvider"]["legend"]["tokenTypes"],
        json!([
            "namespace",
            "type",
            "class",
            "interface",
            "enum",
            "struct",
            "parameter",
            "variable",
            "property",
            "enumMember",
            "event",
            "function",
            "method",
            "keyword",
            "comment",
            "string",
            "number",
            "operator"
        ])
    );
    assert_eq!(
        caps["semanticTokensProvider"]["legend"]["tokenModifiers"],
        json!(["declaration", "documentation", "defaultLibrary", "readonly"])
    );
    assert_eq!(response(&frames, 2)["contents"]["kind"], "markdown");
    assert_eq!(
        response(&frames, 2)["contents"]["value"],
        "**Tasks.complete.task** — parameter\n\ndeclared: `Todo`"
    );
    let completion = response(&frames, 3).as_array().unwrap();
    for (label, kind) in [("task", 6), ("Todo", 7), ("and", 14)] {
        assert_eq!(
            completion.iter().find(|c| c["label"] == label).unwrap()["kind"],
            kind
        );
    }
    assert_eq!(
        response(&frames, 4),
        &json!([{"uri":uri,"range":span(&text,"task",0)}])
    );
    assert_eq!(
        response(&frames, 5),
        &json!([
        {"uri":uri,"range":span(&text,"task",0)}, {"uri":uri,"range":span(&text,"task",1)}])
    );
    assert_document_edit(response(&frames, 6), uri, 7, expected_rename(&text, "task"));
    let data = response(&frames, 7)["data"].as_array().unwrap();
    assert!(!data.is_empty());
    assert_eq!(data.len() % 5, 0);
    let mut line = 0;
    let mut column = 0;
    let decoded: Vec<_> = data
        .as_chunks::<5>()
        .0
        .iter()
        .map(|t| {
            let delta = t[0].as_u64().unwrap();
            line += delta;
            column = if delta == 0 {
                column + t[1].as_u64().unwrap()
            } else {
                t[1].as_u64().unwrap()
            };
            json!([line, column, t[2], t[3], t[4]])
        })
        .collect();
    assert!(
        decoded.contains(&json!([6, 18, 4, 6, 0])),
        "UTF-16 task token: {decoded:?}"
    );
    assert_action(response(&frames, 8), action_uri, 7, &action);
    assert!(diagnostics(&frames, uri, 7).is_array());
    let findings = diagnostics(&frames, action_uri, 7).as_array().unwrap();
    let lint = findings
        .iter()
        .find(|d| d["code"] == "I1002")
        .expect("real lint diagnostic");
    assert_eq!(lint["range"], span(&action, "?.", 0));
    assert_eq!(lint["severity"], 3);
    assert_eq!(lint["source"], "can");
    assert_eq!(response(&frames, 99), &Value::Null);
}

#[test]
fn real_version_increment_requeries_current_source_and_edits() {
    let uri = "untitled:Pass7-version";
    let action_uri = "vscode-remote://ssh-remote+linux/work/action.can";
    let first = capability_text();
    let second = first
        .replace("task", "work")
        .replace("\"😀\"+", "\"é😀😀\"+");
    let action_first = action_text();
    let action_second = action_first.replace("\"😀\"+", "\"é😀😀\"+");
    let mut input = start();
    input.push(open(uri, 7, &first));
    input.push(open(action_uri, 7, &action_first));
    input.push(request(
        2,
        "textDocument/rename",
        rename_params(uri, &first, "task.title"),
    ));
    input.push(request(
        3,
        "textDocument/codeAction",
        action_params(action_uri, &action_first),
    ));
    input.push(change(uri, 8, &second));
    input.push(change(action_uri, 8, &action_second));
    input.push(request(
        4,
        "textDocument/hover",
        at(uri, span(&second, "work", 1)["start"].clone()),
    ));
    input.push(request(
        5,
        "textDocument/rename",
        rename_params(uri, &second, "work.title"),
    ));
    input.push(request(
        6,
        "textDocument/codeAction",
        action_params(action_uri, &action_second),
    ));
    finish(&mut input);
    let frames = session(input);
    assert_eq!(frames.len(), 11, "{frames:#?}");
    assert_eq!(
        span(&second, "work", 1)["start"],
        json!({"line":6,"character":21})
    );
    assert_document_edit(
        response(&frames, 2),
        uri,
        7,
        expected_rename(&first, "task"),
    );
    assert_document_edit(
        response(&frames, 5),
        uri,
        8,
        expected_rename(&second, "work"),
    );
    assert_eq!(
        response(&frames, 4)["contents"]["value"],
        "**Tasks.complete.work** — parameter\n\ndeclared: `Todo`"
    );
    assert_action(response(&frames, 3), action_uri, 7, &action_first);
    assert_action(response(&frames, 6), action_uri, 8, &action_second);
    for (version, text) in [(7, &action_first), (8, &action_second)] {
        let lint = diagnostics(&frames, action_uri, version)
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["code"] == "I1002")
            .unwrap();
        assert_eq!(lint["range"], span(text, "?.", 0));
        assert!(diagnostics(&frames, uri, version).is_array());
    }
    assert_eq!(response(&frames, 99), &Value::Null);
}

#[test]
fn real_opaque_uri_identities_keep_notifications_locations_and_edit_routing() {
    // The first two are semantically equivalent URL spellings but distinct LSP
    // document identities. The last two exercise the String fallback explicitly.
    let uris = [
        "file:///opaque%2fCAP.can",
        "file:///opaque%2FCAP.can",
        "untitled:Opaque-7",
        "vscode-remote://ssh-remote+linux/work/opaque.can",
        "file:///raw-é😀.can",
        "file:///bad%zz.can",
    ];
    let first = capability_text();
    let second = first.replace("task", "work");
    let action = action_text();
    let mut input = start();
    for (index, uri) in uris.iter().enumerate() {
        let (text, name) = if index % 2 == 0 {
            (&first, "task")
        } else {
            (&second, "work")
        };
        input.push(open(uri, 7 + index as i32, text));
        input.push(request(
            2 + index as u32 * 3,
            "textDocument/definition",
            at(uri, span(text, name, 1)["start"].clone()),
        ));
        input.push(request(
            3 + index as u32 * 3,
            "textDocument/rename",
            rename_params(uri, text, &format!("{name}.title")),
        ));
        let mut refs = at(uri, span(text, name, 0)["start"].clone());
        refs["context"] = json!({"includeDeclaration":true});
        input.push(request(
            4 + index as u32 * 3,
            "textDocument/references",
            refs,
        ));
        let action_uri = format!("{uri}.action");
        input.push(open(&action_uri, 7 + index as i32, &action));
        input.push(request(
            40 + index as u32,
            "textDocument/codeAction",
            action_params(&action_uri, &action),
        ));
    }
    // Re-query the first spelling after opening its differently cased sibling.
    input.push(request(
        80,
        "textDocument/hover",
        at(uris[0], span(&first, "task", 1)["start"].clone()),
    ));
    finish(&mut input);
    let frames = session(input);
    assert_eq!(
        frames.len(),
        39,
        "no frames lost for fallback/opaque identities: {frames:#?}"
    );
    for (index, uri) in uris.iter().enumerate() {
        let (text, name) = if index % 2 == 0 {
            (&first, "task")
        } else {
            (&second, "work")
        };
        assert!(diagnostics(&frames, uri, 7 + index as i32).is_array());
        let action_uri = format!("{uri}.action");
        assert_action(
            response(&frames, 40 + index as u32),
            &action_uri,
            7 + index as i32,
            &action,
        );
        assert!(
            diagnostics(&frames, &action_uri, 7 + index as i32)
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "I1002")
        );
        assert_eq!(
            response(&frames, 2 + index as u32 * 3),
            &json!([{"uri":uri,"range":span(text,name,0)}])
        );
        assert_document_edit(
            response(&frames, 3 + index as u32 * 3),
            uri,
            7 + index as i32,
            expected_rename(text, name),
        );
        assert_eq!(
            response(&frames, 4 + index as u32 * 3),
            &json!([
            {"uri":uri,"range":span(text,name,0)},{"uri":uri,"range":span(text,name,1)}])
        );
    }
    assert_eq!(
        response(&frames, 80)["contents"]["value"],
        "**Tasks.complete.task** — parameter\n\ndeclared: `Todo`"
    );
    assert_eq!(response(&frames, 99), &Value::Null);
}
