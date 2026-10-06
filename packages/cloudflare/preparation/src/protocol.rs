//! Length-delimited stdin/stdout frames (P03.1 scaffold).
//!
//! Wire form: `tag: u8` + `len: u32 LE` + `payload: [u8; len]`.
//! Tag 0 = closed JSON metadata, tag 1 = raw byte payload. Stdout
//! carries frames only; diagnostics go to stderr. P03.3 adds the
//! Begin/NeedHost/ResumeHost/Prepared/Failed states on top.

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

/// Protocol identity. Bumped only with a coordinated host change.
pub const PROTOCOL_NAME: &str = "can-preparation";
/// Currently served protocol version.
pub const PROTOCOL_VERSION: u32 = 1;

/// Private per-frame cap: rejects absurd lengths before allocating.
/// Sized for whole-job metadata; module byte maps stream as frames.
pub const MAX_FRAME_BYTES: u32 = 64 * 1024 * 1024;

pub const TAG_JSON: u8 = 0;
pub const TAG_BYTES: u8 = 1;

/// First frame the host must send.
#[derive(Debug, Deserialize)]
pub struct Handshake {
    pub protocol: String,
    pub version: u32,
}

/// Handshake acceptance. `job` names scaffold capability until P04+.
#[derive(Debug, Serialize)]
pub struct HandshakeAccept {
    pub ready: bool,
    pub protocol: String,
    pub version: u32,
    pub job: String,
}

/// Structured failure; the host maps it to the CLI classification.
#[derive(Debug, Serialize)]
pub struct Failure {
    pub error: FailureBody,
}

#[derive(Debug, Serialize)]
pub struct FailureBody {
    pub code: String,
    pub detail: String,
}

impl Failure {
    pub fn new(code: &str, detail: String) -> Self {
        Failure {
            error: FailureBody {
                code: code.to_string(),
                detail,
            },
        }
    }
}

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    Eof,
    BadTag(u8),
    TooLarge(u32),
    Json(serde_json::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(e) => write!(f, "frame io: {e}"),
            FrameError::Eof => write!(f, "unexpected EOF inside frame"),
            FrameError::BadTag(t) => write!(f, "unknown frame tag {t}"),
            FrameError::TooLarge(n) => write!(f, "frame length {n} exceeds cap"),
            FrameError::Json(e) => write!(f, "frame json: {e}"),
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        FrameError::Io(e)
    }
}

/// Read one frame. Returns `Ok(None)` on clean EOF before any byte.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<(u8, Vec<u8>)>, FrameError> {
    let mut tag = [0u8; 1];
    match reader.read_exact(&mut tag) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(FrameError::Io(e)),
    }
    if tag[0] != TAG_JSON && tag[0] != TAG_BYTES {
        return Err(FrameError::BadTag(tag[0]));
    }
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).map_err(|e| {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::Eof
        } else {
            FrameError::Io(e)
        }
    })?;
    let len = u32::from_le_bytes(len);
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(len));
    }
    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload).map_err(|e| {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::Eof
        } else {
            FrameError::Io(e)
        }
    })?;
    Ok(Some((tag[0], payload)))
}

/// Write one frame and flush (interactive host reads reply promptly).
pub fn write_frame(writer: &mut impl Write, tag: u8, payload: &[u8]) -> Result<(), FrameError> {
    if payload.len() > MAX_FRAME_BYTES as usize {
        return Err(FrameError::TooLarge(payload.len() as u32));
    }
    writer.write_all(&[tag])?;
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

/// Write a JSON-tagged frame for any serializable value.
pub fn write_json(writer: &mut impl Write, value: &impl Serialize) -> Result<(), FrameError> {
    let bytes = serde_json::to_vec(value).map_err(FrameError::Json)?;
    write_frame(writer, TAG_JSON, &bytes)
}
