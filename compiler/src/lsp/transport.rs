//! Dependency-free LSP stdio transport: Content-Length framing plus JSON-RPC shapes.
//!
//! [`read_message`] tolerates arbitrarily split reads (any [`BufRead`]
//! chunking, including one byte at a time) and accepts `CRLF` or bare `LF`
//! header endings. The JSON value model lives in [`crate::json`] and is
//! re-exported here so existing `transport::Json` paths keep working.

pub use crate::json::{Json, MAX_JSON_DEPTH, ParseError, parse, render};
use std::io::{self, BufRead, Write};

/// Maximum JSON-RPC body accepted (64 MiB); larger frames are rejected.
pub const MAX_MESSAGE_BYTES: usize = 64 << 20;

/// Maximum complete header section (64 KiB), including line endings and
/// the empty line separating headers from the body. This is a local support
/// budget, not an LSP-specified maximum.
pub const MAX_HEADER_BYTES: usize = 64 << 10;

// Bound each retained body acquisition, including readers with large buffers.
const BODY_CHUNK_BYTES: usize = 8 << 10;

/// Read one Content-Length-framed message body.
///
/// Returns `Ok(None)` on clean EOF before any header byte. Tolerates any
/// read chunking and `CRLF` or bare-`LF` header endings; other headers are
/// ignored within [`MAX_HEADER_BYTES`]. Equal repeated Content-Length values
/// are accepted; conflicting values, malformed lengths and budget violations
/// are `InvalidData` errors. Body storage grows only when payload arrives,
/// geometrically up to the declared length; an absent payload allocates none.
/// Callers must close the stream on framing errors: no resynchronization is
/// promised. EOF inside headers or a body is `UnexpectedEof`.
pub fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut content_length: Option<usize> = None;
    let mut header_bytes = 0;
    let mut line = Vec::new();
    loop {
        line.clear();
        if !read_header_line(reader, &mut line, &mut header_bytes)? {
            return Ok(None);
        }
        while line.last() == Some(&b'\n') || line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            break;
        }
        let mut parts = line.splitn(2, |b| *b == b':');
        let name = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        if name.eq_ignore_ascii_case(b"Content-Length") {
            let digits = std::str::from_utf8(value.trim_ascii())
                .map_err(|_| invalid_data("bad Content-Length"))?;
            let length: usize = digits
                .parse()
                .map_err(|_| invalid_data("bad Content-Length"))?;
            if length > MAX_MESSAGE_BYTES {
                return Err(invalid_data("message exceeds size cap"));
            }
            if content_length.is_some_and(|previous| previous != length) {
                return Err(invalid_data("conflicting Content-Length"));
            }
            content_length = Some(length);
        }
    }
    let length = content_length.ok_or_else(|| invalid_data("missing Content-Length"))?;
    let mut body = Vec::new();
    while body.len() < length {
        let available = match reader.fill_buf() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if available.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "EOF inside LSP body",
            ));
        }
        let count = available
            .len()
            .min(length - body.len())
            .min(BODY_CHUNK_BYTES);
        let needed = body.len() + count;
        if needed > body.capacity() {
            let target = body
                .capacity()
                .max(BODY_CHUNK_BYTES)
                .saturating_mul(2)
                .min(length)
                .max(needed);
            body.try_reserve_exact(target - body.len())
                .map_err(|_| allocation_error())?;
        }
        body.extend_from_slice(&available[..count]);
        reader.consume(count);
    }
    Ok(Some(body))
}

/// Acquire a line without retaining any byte beyond the total header budget.
fn read_header_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    total: &mut usize,
) -> io::Result<bool> {
    loop {
        if *total == MAX_HEADER_BYTES {
            return Err(invalid_data("headers exceed size cap"));
        }
        let available = match reader.fill_buf() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if available.is_empty() {
            return if *total == 0 {
                Ok(false)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "EOF inside LSP headers",
                ))
            };
        }
        let bounded = &available[..available.len().min(MAX_HEADER_BYTES - *total)];
        let count = bounded
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bounded.len(), |position| position + 1);
        let needed = line.len() + count;
        if needed > line.capacity() {
            let target = line
                .capacity()
                .max(32)
                .saturating_mul(2)
                .min(MAX_HEADER_BYTES)
                .max(needed);
            line.try_reserve_exact(target - line.len())
                .map_err(|_| allocation_error())?;
        }
        line.extend_from_slice(&bounded[..count]);
        *total += count;
        reader.consume(count);
        if line.last() == Some(&b'\n') {
            return Ok(true);
        }
    }
}

fn allocation_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::OutOfMemory,
        "LSP frame storage allocation failed",
    )
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Write one Content-Length-framed message body.
pub fn write_message<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)?;
    writer.flush()
}

/// Standard JSON-RPC error codes used by the server.
pub mod error_code {
    /// Invalid JSON received.
    pub const PARSE: i64 = -32700;
    /// Message is not a valid request.
    pub const INVALID_REQUEST: i64 = -32600;
    /// Unknown method.
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// Bad or missing parameters.
    pub const INVALID_PARAMS: i64 = -32602;
    /// Internal error while handling.
    pub const INTERNAL: i64 = -32603;
    /// Request arrived before `initialize`.
    pub const SERVER_NOT_INITIALIZED: i64 = -32002;
    // No REQUEST_CANCELLED (-32800): stale versions cancel
    // notification-triggered work that has no request id to answer, so
    // the code is unusable; `$/cancelRequest` is a documented no-op.
}

/// A decoded JSON-RPC call: request (`id` present) or notification (`None`).
#[derive(Debug, Clone)]
pub struct RpcCall {
    /// Request id echoed in the response; `None` for notifications.
    pub id: Option<Json>,
    /// Method name, e.g. `textDocument/hover`.
    pub method: String,
    /// Structured params, preserving omission separately from explicit null.
    pub params: Option<Json>,
}

/// Invalid envelope, with a unique legal request id when safe to echo.
#[derive(Debug, Clone)]
pub struct RpcCallError {
    /// Unique legal id to echo, or null correlation when absent or invalid.
    pub id: Option<Json>,
}

/// Interpret an LSP integer exactly, without floating-point rounding or
/// allocation proportional to a decimal exponent. JSON grammar is already parsed.
pub(crate) fn integer_value(value: &Json) -> Option<i32> {
    let Json::Num(raw) = value else { return None };
    let negative = raw.starts_with('-');
    let unsigned = raw.strip_prefix('-').unwrap_or(raw);
    let (coefficient, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let fractional = coefficient
        .split_once('.')
        .map_or(0, |(_, tail)| tail.len());
    let mut significant = 0usize;
    let mut trailing = 0usize;
    for digit in coefficient.bytes().filter(|b| *b != b'.') {
        if significant == 0 && digit == b'0' {
            continue;
        }
        significant += 1;
        trailing = if digit == b'0' { trailing + 1 } else { 0 };
    }
    if significant == 0 {
        return Some(0);
    }
    let exponent_negative = exponent.starts_with('-');
    let mut power = 0i64;
    for digit in exponent.trim_start_matches(['-', '+']).bytes() {
        power = power
            .saturating_mul(10)
            .saturating_add(i64::from(digit - b'0'));
    }
    if exponent_negative {
        power = -power;
    }
    power = power
        .saturating_sub(fractional as i64)
        .saturating_add(trailing as i64);
    let digits = significant - trailing;
    if power < 0 || (digits as i64).saturating_add(power) > 10 {
        return None;
    }
    // Re-fold only the significant prefix, dropping all trailing zero digits.
    let mut magnitude = 0i64;
    for digit in coefficient
        .bytes()
        .filter(|b| *b != b'.')
        .skip_while(|b| *b == b'0')
        .take(digits)
    {
        magnitude = magnitude * 10 + i64::from(digit - b'0');
    }
    for _ in 0..power {
        magnitude *= 10;
    }
    if negative {
        magnitude = -magnitude;
    }
    i32::try_from(magnitude).ok()
}

pub(crate) fn valid_id(value: &Json) -> bool {
    matches!(value, Json::Str(_)) || integer_value(value).is_some()
}

/// Admit the JSON-RPC envelope before lifecycle or method-specific validation.
pub fn parse_call(message: &Json) -> Result<RpcCall, RpcCallError> {
    let Json::Obj(members) = message else {
        return Err(RpcCallError { id: None });
    };
    let mut reserved = [0usize; 4];
    for (key, _) in members {
        if let Some(index) = ["jsonrpc", "id", "method", "params"]
            .iter()
            .position(|name| key == name)
        {
            reserved[index] += 1;
        }
    }
    let id = if reserved[1] == 1 {
        message.get("id").filter(|id| valid_id(id)).cloned()
    } else {
        None
    };
    let invalid = || RpcCallError { id: id.clone() };
    if reserved.iter().any(|count| *count > 1)
        || (reserved[1] == 1 && id.is_none())
        || message.get("jsonrpc").and_then(Json::as_str) != Some("2.0")
    {
        return Err(invalid());
    }
    let method = message
        .get("method")
        .and_then(Json::as_str)
        .ok_or_else(invalid)?;
    let params = message.get("params");
    if let Some(params) = params
        && !matches!(params, Json::Obj(_) | Json::Arr(_))
        && !(matches!(params, Json::Null) && matches!(method, "shutdown" | "exit"))
    {
        return Err(invalid());
    }
    Ok(RpcCall {
        id,
        method: method.to_string(),
        params: params.cloned(),
    })
}

/// Build a success response body for `id`.
pub fn response_ok(id: &Json, result: Json) -> String {
    render(&Json::Obj(vec![
        ("jsonrpc".to_string(), Json::Str("2.0".to_string())),
        ("id".to_string(), id.clone()),
        ("result".to_string(), result),
    ]))
}

/// Build an error response body. `id` is `None` only when the request id
/// itself was unreadable, in which case JSON-RPC mandates `null`.
pub fn response_err(id: Option<&Json>, code: i64, message: &str) -> String {
    let id = id.cloned().unwrap_or(Json::Null);
    let code_lexeme = code.to_string();
    render(&Json::Obj(vec![
        ("jsonrpc".to_string(), Json::Str("2.0".to_string())),
        ("id".to_string(), id),
        (
            "error".to_string(),
            Json::Obj(vec![
                ("code".to_string(), Json::Num(code_lexeme)),
                ("message".to_string(), Json::Str(message.to_string())),
            ]),
        ),
    ]))
}

/// Build a server-to-client notification body.
pub fn notification(method: &str, params: Json) -> String {
    render(&Json::Obj(vec![
        ("jsonrpc".to_string(), Json::Str("2.0".to_string())),
        ("method".to_string(), Json::Str(method.to_string())),
        ("params".to_string(), params),
    ]))
}

