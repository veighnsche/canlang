//! Retained-session job loop (P03.3 states).
//!
//! One process serves one job: handshake, then exactly one `Begin`,
//! then the stage sequence with at most one open `NeedHost` (token
//! resumes exactly once, in issue order), then one terminal
//! (`Prepared` or `Failed`). P03.3 runs a fixed two-probe scaffold
//! sequence; P04+ replaces `run_stages` with real stage execution
//! while this state machine (tokens, abort, EOF, failure mapping)
//! stays frozen.

use crate::failures::semantic;
use crate::failures::transport;
use crate::protocol::{
    parse_host_message, read_frame, write_json, Failure, FrameError, Handshake, HandshakeAccept,
    HostMessage, NeedBody, NeedHost, Prepared, PreparedBody, PROTOCOL_NAME, PROTOCOL_VERSION,
    TAG_JSON,
};
use std::io::{Read, Write};

/// Scaffold stage script (P03.3): fixed probe sequence proving the
/// request/resume machinery. P04+ replaces it with real stages.
const SCAFFOLD_STAGES: [&str; 2] = ["mcp_bun_probe", "catalog_probe"];

/// Serve one job. Returns the process exit code (0 clean EOF,
/// terminal `Prepared`, or acknowledged `Abort`; 1 framing or
/// protocol violation at any point).
pub fn run_job(reader: &mut impl Read, writer: &mut impl Write) -> i32 {
    match serve(reader, writer) {
        Ok(()) => 0,
        Err(code) => code,
    }
}

/// Read the next host message frame. Maps transport failures to the
/// abort path; `Ok(None)` is clean EOF between messages.
fn next_message(reader: &mut impl Read, what: &str) -> Result<Option<(u8, Vec<u8>)>, Failure> {
    match read_frame(reader) {
        Ok(frame) => Ok(frame),
        Err(FrameError::Eof) => Err(Failure::new(
            transport::TRUNCATED,
            format!("{what}: truncated frame"),
        )),
        Err(FrameError::TooLarge(n)) => Err(Failure::new(
            transport::FRAME_TOO_LARGE,
            format!("{what}: declared length {n} exceeds cap"),
        )),
        Err(FrameError::BadTag(t)) => Err(Failure::new(
            transport::FRAME_CORRUPT,
            format!("{what}: unknown frame tag {t}"),
        )),
        Err(e) => Err(Failure::new(
            transport::FRAME_CORRUPT,
            format!("{what}: invalid frame ({e})"),
        )),
    }
}

/// Emit a terminal `Failed` frame. Best effort: a dead peer fails the
/// job, never hangs it.
fn fail(writer: &mut impl Write, failure: &Failure) {
    let _ = write_json(writer, failure);
}

fn serve(reader: &mut impl Read, writer: &mut impl Write) -> Result<(), i32> {
    let (tag, payload) = match read_frame(reader) {
        Ok(Some(frame)) => frame,
        Ok(None) => {
            eprintln!("can-preparation: empty session (EOF before handshake)");
            return Ok(());
        }
        Err(e) => {
            eprintln!("can-preparation: handshake frame invalid: {e}");
            return Err(1);
        }
    };
    if tag != TAG_JSON {
        eprintln!("can-preparation: handshake must be a JSON frame");
        return Err(1);
    }
    let hello: Handshake = match serde_json::from_slice(&payload) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("can-preparation: handshake is not a Handshake: {e}");
            return Err(1);
        }
    };
    if hello.protocol != PROTOCOL_NAME || hello.version != PROTOCOL_VERSION {
        let failure = Failure::new(
            transport::VERSION_MISMATCH,
            format!(
                "want {} v{}, got {} v{}",
                PROTOCOL_NAME, PROTOCOL_VERSION, hello.protocol, hello.version
            ),
        );
        let _ = write_json(writer, &failure);
        return Err(1);
    }
    if write_json(
        writer,
        &HandshakeAccept {
            ready: true,
            protocol: PROTOCOL_NAME.to_string(),
            version: PROTOCOL_VERSION,
            job: "scaffold-probes".to_string(),
        },
    )
    .is_err()
    {
        return Err(1);
    }
    // Exactly one Begin opens the job. EOF here is a clean no-job
    // session; anything else is a violation.
    let mode = match next_message(reader, "begin") {
        Err(failure) => {
            eprintln!("can-preparation: {}", failure.error.detail);
            fail(writer, &failure);
            return Err(1);
        }
        Ok(None) => return Ok(()),
        Ok(Some((tag, payload))) => {
            if tag != TAG_JSON {
                let failure = Failure::new(
                    transport::FRAME_CORRUPT,
                    "begin: expected a JSON frame".to_string(),
                );
                eprintln!("can-preparation: {}", failure.error.detail);
                fail(writer, &failure);
                return Err(1);
            }
            match parse_host_message(&payload) {
                Some(HostMessage::Begin(begin)) => begin.mode,
                Some(HostMessage::Abort(abort)) => {
                    eprintln!(
                        "can-preparation: aborted before begin{}",
                        abort.reason.map(|r| format!(": {r}")).unwrap_or_default()
                    );
                    fail(
                        writer,
                        &Failure::new(semantic::ABORTED, "aborted before begin".to_string()),
                    );
                    return Ok(());
                }
                _ => {
                    let failure = Failure::new(
                        transport::PROTOCOL_VIOLATION,
                        "begin: expected {begin:{mode}}".to_string(),
                    );
                    eprintln!("can-preparation: {}", failure.error.detail);
                    fail(writer, &failure);
                    return Err(1);
                }
            }
        }
    };
    run_stages(reader, writer, &mode)
}

/// Walk the stage script: one open NeedHost at a time, each token
/// resuming exactly once, then terminal Prepared.
fn run_stages(reader: &mut impl Read, writer: &mut impl Write, mode: &str) -> Result<(), i32> {
    let mut resumes: Vec<serde_json::Value> = Vec::new();
    for (index, stage) in SCAFFOLD_STAGES.iter().enumerate() {
        let token = index as u64 + 1;
        let need = NeedHost {
            need: NeedBody {
                token,
                stage: stage.to_string(),
                request: serde_json::json!({"probe": stage}),
            },
        };
        if write_json(writer, &need).is_err() {
            return Err(1);
        }
        match next_message(reader, &format!("resume token {token}")) {
            Err(failure) => {
                eprintln!("can-preparation: {}", failure.error.detail);
                fail(writer, &failure);
                return Err(1);
            }
            Ok(None) => {
                let failure = Failure::new(
                    transport::TRUNCATED,
                    format!("resume token {token}: EOF with NeedHost open"),
                );
                eprintln!("can-preparation: {}", failure.error.detail);
                fail(writer, &failure);
                return Err(1);
            }
            Ok(Some((tag, payload))) => {
                if tag != TAG_JSON {
                    let failure = Failure::new(
                        transport::FRAME_CORRUPT,
                        format!("resume token {token}: expected a JSON frame"),
                    );
                    eprintln!("can-preparation: {}", failure.error.detail);
                    fail(writer, &failure);
                    return Err(1);
                }
                match parse_host_message(&payload) {
                    Some(HostMessage::Resume(resume)) if resume.token == token => {
                        resumes.push(resume.payload);
                    }
                    Some(HostMessage::Abort(abort)) => {
                        eprintln!(
                            "can-preparation: aborted with token {token} open{}",
                            abort.reason.map(|r| format!(": {r}")).unwrap_or_default()
                        );
                        fail(
                            writer,
                            &Failure::new(
                                semantic::ABORTED,
                                format!("aborted with token {token} open"),
                            ),
                        );
                        return Ok(());
                    }
                    _ => {
                        let failure = Failure::new(
                            transport::PROTOCOL_VIOLATION,
                            format!("resume token {token}: expected {{resume:{{token:{token}}}}}"),
                        );
                        eprintln!("can-preparation: {}", failure.error.detail);
                        fail(writer, &failure);
                        return Err(1);
                    }
                }
            }
        }
    }
    let prepared = Prepared {
        prepared: PreparedBody {
            scaffold: true,
            mode: mode.to_string(),
            stages: SCAFFOLD_STAGES.iter().map(|s| s.to_string()).collect(),
            resumes,
        },
    };
    if write_json(writer, &prepared).is_err() {
        return Err(1);
    }
    Ok(())
}
