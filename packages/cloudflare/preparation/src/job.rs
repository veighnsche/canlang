//! Retained-session job loop (P03.1 scaffold).
//!
//! One process serves one job: handshake first, then frames until
//! EOF. Job execution is unimplemented until P04+ — every post-
//! handshake frame receives a typed `unimplemented` failure and the
//! session stays open, proving the retained loop without semantics.

use crate::failures::semantic;
use crate::failures::transport;
use crate::protocol::{
    read_frame, write_json, Failure, FrameError, Handshake, HandshakeAccept, PROTOCOL_NAME,
    PROTOCOL_VERSION, TAG_JSON,
};
use std::io::{Read, Write};

/// Serve one job. Returns the process exit code (0 clean EOF or
/// requested shutdown; 1 framing/protocol violation).
pub fn run_job(reader: &mut impl Read, writer: &mut impl Write) -> i32 {
    match serve(reader, writer) {
        Ok(()) => 0,
        Err(code) => code,
    }
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
            job: "unimplemented".to_string(),
        },
    )
    .is_err()
    {
        return Err(1);
    }
    loop {
        match read_frame(reader) {
            Ok(None) => return Ok(()),
            Ok(Some(_)) => {
                // Scaffold: no job semantics yet (P04+). Typed failure
                // keeps the session open for further frames.
                let failure = Failure::new(
                    semantic::UNIMPLEMENTED,
                    "job execution lands in P04+; scaffold serves framing only".to_string(),
                );
                if write_json(writer, &failure).is_err() {
                    return Err(1);
                }
            }
            Err(FrameError::Eof) => {
                eprintln!("can-preparation: truncated frame; aborting session");
                return Err(1);
            }
            Err(e) => {
                eprintln!("can-preparation: invalid frame: {e}; aborting session");
                return Err(1);
            }
        }
    }
}
