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

/// Read one Content-Length-framed message body.
///
/// Returns `Ok(None)` on clean EOF before any header byte. Tolerates any
/// read chunking and `CRLF` or bare-`LF` header endings; other headers are
/// ignored. Malformed framing and oversized bodies are `InvalidData` errors.
pub fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut content_length: Option<usize> = None;
    let mut saw_any_byte = false;
    loop {
        let mut line = Vec::new();
        let count = reader.read_until(b'\n', &mut line)?;
        if count == 0 {
            if saw_any_byte {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "EOF inside LSP headers",
                ));
            }
            return Ok(None);
        }
        saw_any_byte = true;
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
            content_length = Some(length);
        }
    }
    let length = content_length.ok_or_else(|| invalid_data("missing Content-Length"))?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
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
    /// Params object/array, or [`Json::Null`] when absent.
    pub params: Json,
}

/// Decode a parsed message body into a call. Returns `None` when the value
/// is not an object with a string `method`.
pub fn parse_call(message: &Json) -> Option<RpcCall> {
    let method = message.get("method")?.as_str()?.to_string();
    let id = match message.get("id") {
        None | Some(Json::Null) => None,
        Some(id) => Some(id.clone()),
    };
    let params = message.get("params").cloned().unwrap_or(Json::Null);
    Some(RpcCall { id, method, params })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn json_round_trip_with_escapes_and_unicode() {
        let text =
            r#"{"s":"a\"b\\c\ndé😀","u":"é","n":-1.5e2,"t":true,"z":null,"a":[1,"x"],"o":{}}"#;
        let value = parse(text).unwrap();
        assert_eq!(value.get("s").unwrap().as_str().unwrap(), "a\"b\\c\ndé😀");
        assert_eq!(value.get("u").unwrap().as_str().unwrap(), "é");
        assert_eq!(parse(&render(&value)).unwrap(), value);
    }

    #[test]
    fn surrogate_pairs_decode_and_lone_surrogates_fail() {
        assert_eq!(
            parse(r#""\uD83D\uDE00""#).unwrap(),
            Json::Str("😀".to_string())
        );
        assert!(parse(r#""\uD83D""#).is_err());
        assert!(parse(r#""\uDE00""#).is_err());
        assert!(parse("\"a\u{0001}b\"").is_err());
    }

    #[test]
    fn malformed_json_rejected() {
        let deep = "[".repeat(MAX_JSON_DEPTH + 2);
        let cases = [
            "",
            "{",
            "{\"a\":}",
            "[1,]",
            "01",
            "1.",
            "nul",
            "{\"a\":1} trailing",
            deep.as_str(),
        ];
        for bad in cases {
            assert!(parse(bad).is_err(), "accepted: {bad:?}");
        }
    }

    #[test]
    fn framing_round_trip_with_split_reads() {
        let bodies = [br#"{"id":1}"#.as_slice(), br#"[1,2]"#.as_slice()];
        let mut wire = Vec::new();
        for body in bodies {
            write_message(&mut wire, body).unwrap();
        }
        // Feed the wire one byte at a time through a buffered reader.
        struct Drip<'a> {
            data: &'a [u8],
            pos: usize,
        }
        impl io::Read for Drip<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.pos >= self.data.len() || buf.is_empty() {
                    return Ok(0);
                }
                buf[0] = self.data[self.pos];
                self.pos += 1;
                Ok(1)
            }
        }
        let mut reader = BufReader::new(Drip {
            data: &wire,
            pos: 0,
        });
        for body in bodies {
            assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some(body));
        }
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn framing_errors_are_invalid_data() {
        let mut reader = BufReader::new(Cursor::new(b"Content-Length: 4\r\n\r\nabc"));
        assert_eq!(
            read_message(&mut reader).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut reader = BufReader::new(Cursor::new(b"X-Bogus: 1\r\n\r\n"));
        assert_eq!(
            read_message(&mut reader).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn large_multibyte_string_parses_in_linear_time() {
        // ~100KB of CJK (3 bytes/scalar): the old whole-tail `from_utf8`
        // per scalar was O(n^2) here (seconds in debug); the lead-byte
        // decode must stay far under this generous bound.
        let body = "あ".repeat(34_000);
        let text = format!("\"{body}\"");
        let start = std::time::Instant::now();
        let value = parse(&text).unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
        assert_eq!(value, Json::Str(body));
    }

    #[test]
    fn malformed_content_length_values_rejected() {
        // Non-numeric, negative, and empty lengths are InvalidData, and an
        // over-cap length is rejected before any allocation is attempted.
        let headers = [
            "Content-Length: abc\r\n\r\n".to_string(),
            "Content-Length: -5\r\n\r\n".to_string(),
            "Content-Length: \r\n\r\n".to_string(),
            "Content-Length: 4x\r\n\r\n".to_string(),
            "Content-Length: 99999999999999999999999\r\n\r\n".to_string(),
            format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1),
        ];
        for header in &headers {
            let mut reader = BufReader::new(Cursor::new(header.as_bytes()));
            assert_eq!(
                read_message(&mut reader).unwrap_err().kind(),
                io::ErrorKind::InvalidData,
                "header: {header:?}"
            );
        }
        // Exactly at the cap the header parses (the body read then fails
        // on the short fixture with UnexpectedEof, proving the length was
        // accepted rather than rejected as oversize).
        let header = format!("Content-Length: {MAX_MESSAGE_BYTES}\r\n\r\n");
        let mut reader = BufReader::new(Cursor::new(header.as_bytes()));
        assert_eq!(
            read_message(&mut reader).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn rpc_builders_shape() {
        let id = Json::Num("7".to_string());
        let ok = response_ok(&id, Json::Null);
        assert!(ok.contains("\"id\":7") && ok.contains("\"result\":null"));
        let err = response_err(Some(&id), error_code::METHOD_NOT_FOUND, "nope");
        assert!(err.contains("\"code\":-32601") && err.contains("\"message\":\"nope\""));
        let note = notification("m", Json::Obj(vec![]));
        assert!(note.contains("\"method\":\"m\"") && !note.contains("\"id\""));
        let call = parse_call(&parse(r#"{"method":"m","params":[1]}"#).unwrap()).unwrap();
        assert!(call.id.is_none() && call.method == "m");
    }
}
