//! Real executable regression controls for failed stderr in the unwind hook.
//! Unix socket endpoints deterministically produce EPIPE; the retained Python
//! probe separately establishes actual anonymous pipes and owned-file EFBIG.
#![cfg(unix)]

use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};

fn closed_sink() -> Stdio {
    let (writer, reader) = UnixStream::pair().expect("owned socket pair");
    drop(reader);
    Stdio::from(OwnedFd::from(writer))
}

fn can() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
    command.stdin(Stdio::null());
    command.env_remove("CAN_INTERNAL_TEST_PANIC");
    command
}

#[test]
fn internal_unwind_with_failed_stderr_still_exits_two() {
    let output = can()
        .arg("--help")
        .env("CAN_INTERNAL_TEST_PANIC", "1")
        .stderr(closed_sink())
        .output()
        .expect("spawn can with failed stderr");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}

#[test]
fn broken_output_preserves_success_and_tool_failure_codes() {
    let output = can()
        .arg("--help")
        .stdout(closed_sink())
        .output()
        .expect("spawn can with failed stdout");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());

    let output = can()
        .arg("unknown-command")
        .stderr(closed_sink())
        .output()
        .expect("spawn can with failed stderr");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}

#[test]
fn broken_stdout_preserves_diagnostics_code() {
    let root = tempfile::tempdir().expect("owned fixture directory");
    let input = root.path().join("bad.can");
    std::fs::write(&input, "this is not {.can syntax !!!\n").expect("write invalid source");
    let output = can()
        .args(["fmt", input.to_str().expect("fixture UTF8 path")])
        .stdout(closed_sink())
        .output()
        .expect("spawn can with failed diagnostic output");
    assert_eq!(output.status.code(), Some(10));
    assert!(output.stderr.is_empty());
}
