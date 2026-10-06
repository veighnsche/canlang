//! Protocol state tests (P03.3): spawn the real binary and drive
//! the session wire. Every case pins deterministic behavior for a
//! framing, token, order, version or cancellation edge.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn binary() -> String {
    env!("CARGO_BIN_EXE_can-preparation").to_string()
}

fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(tag);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

fn json_frame(value: &serde_json::Value) -> Vec<u8> {
    frame(0, &serde_json::to_vec(value).unwrap())
}

fn handshake(version: u32) -> Vec<u8> {
    json_frame(&serde_json::json!({"protocol": "can-preparation", "version": version}))
}

fn begin(mode: &str) -> Vec<u8> {
    json_frame(&serde_json::json!({"begin": {"mode": mode}}))
}

fn resume(token: u64, payload: serde_json::Value) -> Vec<u8> {
    json_frame(&serde_json::json!({"resume": {"token": token, "payload": payload}}))
}

struct Run {
    status: i32,
    stdout_frames: Vec<(u8, Vec<u8>)>,
    stdout_trailing: Vec<u8>,
    stderr: String,
}

fn parse_frames(mut bytes: &[u8]) -> (Vec<(u8, Vec<u8>)>, Vec<u8>) {
    let mut frames = Vec::new();
    while bytes.len() >= 5 {
        let tag = bytes[0];
        let len = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        if bytes.len() < 5 + len {
            break;
        }
        frames.push((tag, bytes[5..5 + len].to_vec()));
        bytes = &bytes[5 + len..];
    }
    (frames, bytes.to_vec())
}

/// Feed `input`, close stdin, wait up to 10s, parse stdout frames.
fn run_session(input: &[u8]) -> Run {
    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn can-preparation");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input)
        .expect("write stdin");
    drop(child.stdin.take());
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    // Bounded wait: the binary must never hang a closed session.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait().expect("try_wait") {
            Some(status) => {
                child
                    .stdout
                    .as_mut()
                    .unwrap()
                    .read_to_end(&mut stdout)
                    .unwrap();
                child
                    .stderr
                    .as_mut()
                    .unwrap()
                    .read_to_end(&mut stderr)
                    .unwrap();
                let (frames, trailing) = parse_frames(&stdout);
                return Run {
                    status: status.code().unwrap_or(99),
                    stdout_frames: frames,
                    stdout_trailing: trailing,
                    stderr: String::from_utf8_lossy(&stderr).into_owned(),
                };
            }
            None => {
                if std::time::Instant::now() > deadline {
                    child.kill().ok();
                    panic!("binary hung on closed stdin");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn json_of(frame: &(u8, Vec<u8>)) -> serde_json::Value {
    assert_eq!(frame.0, 0, "expected JSON frame");
    serde_json::from_slice(&frame.1).expect("frame is JSON")
}

#[test]
fn handshake_then_clean_eof_exits_zero() {
    let run = run_session(&handshake(1));
    assert_eq!(run.status, 0, "stderr: {}", run.stderr);
    assert!(run.stdout_trailing.is_empty());
    assert_eq!(run.stdout_frames.len(), 1);
    let accept = json_of(&run.stdout_frames[0]);
    assert_eq!(accept["ready"], true);
    assert_eq!(accept["protocol"], "can-preparation");
    assert_eq!(accept["version"], 1);
}

#[test]
fn full_probe_sequence_prepares() {
    let mut input = handshake(1);
    input.extend_from_slice(&begin("deploy-preview"));
    input.extend_from_slice(&resume(1, serde_json::json!({"mcp": "ok"})));
    input.extend_from_slice(&resume(2, serde_json::json!({"catalog": [1, 2]})));
    let run = run_session(&input);
    assert_eq!(run.status, 0, "stderr: {}", run.stderr);
    assert!(run.stdout_trailing.is_empty());
    assert_eq!(run.stdout_frames.len(), 4);
    let need1 = json_of(&run.stdout_frames[1]);
    assert_eq!(need1["need"]["token"], 1);
    assert_eq!(need1["need"]["stage"], "mcp_bun_probe");
    let need2 = json_of(&run.stdout_frames[2]);
    assert_eq!(need2["need"]["token"], 2);
    assert_eq!(need2["need"]["stage"], "catalog_probe");
    let prepared = json_of(&run.stdout_frames[3]);
    assert_eq!(prepared["prepared"]["scaffold"], true);
    assert_eq!(prepared["prepared"]["mode"], "deploy-preview");
    assert_eq!(
        prepared["prepared"]["stages"],
        serde_json::json!(["mcp_bun_probe", "catalog_probe"])
    );
    assert_eq!(
        prepared["prepared"]["resumes"],
        serde_json::json!([{"mcp": "ok"}, {"catalog": [1, 2]}])
    );
}

#[test]
fn version_mismatch_fails_closed() {
    let run = run_session(&handshake(999));
    assert_eq!(run.status, 1);
    assert!(run.stdout_trailing.is_empty());
    assert_eq!(run.stdout_frames.len(), 1);
    let failed = json_of(&run.stdout_frames[0]);
    assert_eq!(failed["error"]["code"], "version-mismatch");
}

#[test]
fn token_mismatch_fails_closed() {
    let mut input = handshake(1);
    input.extend_from_slice(&begin("build"));
    input.extend_from_slice(&resume(7, serde_json::json!(null)));
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "protocol-violation");
}

#[test]
fn resume_before_any_need_is_skew() {
    let mut input = handshake(1);
    input.extend_from_slice(&resume(1, serde_json::json!(null)));
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "protocol-violation");
}

#[test]
fn replayed_token_fails_on_second_use() {
    let mut input = handshake(1);
    input.extend_from_slice(&begin("build"));
    input.extend_from_slice(&resume(1, serde_json::json!("first")));
    // Token 1 is consumed; token 2 is open — replaying 1 must fail.
    input.extend_from_slice(&resume(1, serde_json::json!("replay")));
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "protocol-violation");
}

#[test]
fn second_begin_is_rejected() {
    let mut input = handshake(1);
    input.extend_from_slice(&begin("build"));
    input.extend_from_slice(&begin("build"));
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "protocol-violation");
}

#[test]
fn unknown_message_shape_is_rejected() {
    let mut input = handshake(1);
    input.extend_from_slice(&json_frame(&serde_json::json!({"frobnicate": true})));
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "protocol-violation");
}

#[test]
fn truncated_frame_aborts_deterministically() {
    let mut input = handshake(1);
    input.extend_from_slice(&begin("build"));
    // Declares 64 payload bytes, delivers 3, then EOF.
    input.extend_from_slice(&[0, 64, 0, 0, 0, 1, 2, 3]);
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "truncated");
}

#[test]
fn oversized_length_rejects_before_allocating() {
    let mut input = handshake(1);
    // 0xFFFFFFFF declared; only a stub follows, then EOF.
    input.extend_from_slice(&[0, 255, 255, 255, 255, 0]);
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "frame-too-large");
}

#[test]
fn unknown_frame_tag_rejects() {
    let mut input = handshake(1);
    input.extend_from_slice(&frame(9, b"{}"));
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "frame-corrupt");
}

#[test]
fn abort_mid_need_ends_cleanly() {
    let mut input = handshake(1);
    input.extend_from_slice(&begin("build"));
    input.extend_from_slice(&json_frame(&serde_json::json!({"abort": {}})));
    let run = run_session(&input);
    assert_eq!(run.status, 0, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "aborted");
}

#[test]
fn eof_with_need_open_is_truncated() {
    let mut input = handshake(1);
    input.extend_from_slice(&begin("build"));
    // No resume; stdin closes with token 1 open.
    let run = run_session(&input);
    assert_eq!(run.status, 1, "stderr: {}", run.stderr);
    let last = json_of(run.stdout_frames.last().unwrap());
    assert_eq!(last["error"]["code"], "truncated");
}

#[test]
fn empty_session_exits_zero() {
    let run = run_session(&[]);
    assert_eq!(run.status, 0, "stderr: {}", run.stderr);
    assert!(run.stdout_frames.is_empty());
}
