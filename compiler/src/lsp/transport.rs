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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

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
    fn framing_preserves_the_bare_lf_compatibility_extension() {
        let mut reader = BufReader::new(Drip {
            data: b"Content-Length: 2\n\n{}",
            pos: 0,
        });
        assert_eq!(read_message(&mut reader).unwrap(), Some(b"{}".to_vec()));
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn framing_preserves_malformed_utf8_and_the_next_frame() {
        // All would be repairable into JSON strings by lossy conversion.
        let invalid_sequences: &[&[u8]] = &[
            &[0xff],                   // Invalid leading byte.
            &[0x80],                   // Unpaired continuation byte.
            &[0xc0, 0xaf],             // Overlong encoding.
            &[0xe2, 0x28, 0xa1],       // Invalid continuation byte.
            &[0xed, 0xa0, 0x80],       // Encoded surrogate.
            &[0xf4, 0x90, 0x80, 0x80], // Scalar above U+10FFFF.
        ];
        for sequence in invalid_sequences {
            let mut body = b"{\"id\":\"".to_vec();
            let offset = body.len();
            body.extend_from_slice(sequence);
            body.extend_from_slice(b"\",\"method\":\"initialize\"}");
            let next = br#"{"method":"exit"}"#;
            let mut wire = Vec::new();
            write_message(&mut wire, &body).unwrap();
            write_message(&mut wire, next).unwrap();
            let mut reader = BufReader::new(Drip {
                data: &wire,
                pos: 0,
            });

            let framed_body = read_message(&mut reader).unwrap().unwrap();
            assert_eq!(framed_body, body);
            assert_eq!(
                std::str::from_utf8(&framed_body).unwrap_err().valid_up_to(),
                offset
            );
            let framed_next = read_message(&mut reader).unwrap().unwrap();
            assert_eq!(framed_next, next);
            assert_eq!(read_message(&mut reader).unwrap(), None);
        }
    }

    #[test]
    fn incomplete_utf8_sequence_stops_at_the_body_boundary() {
        // A following frame must not complete the first body's code point.
        for sequence in [&[0xc2][..], &[0xe2, 0x82][..], &[0xf0, 0x9f, 0x98][..]] {
            let mut body = b"\"".to_vec();
            body.extend_from_slice(sequence);
            let mut wire = Vec::new();
            write_message(&mut wire, &body).unwrap();
            write_message(&mut wire, br#""valid""#).unwrap();
            let mut reader = BufReader::new(Drip {
                data: &wire,
                pos: 0,
            });
            let framed_body = read_message(&mut reader).unwrap().unwrap();
            assert_eq!(framed_body, body);
            let error = std::str::from_utf8(&framed_body).unwrap_err();
            assert_eq!(error.valid_up_to(), 1);
            assert_eq!(error.error_len(), None);
            let next = read_message(&mut reader).unwrap().unwrap();
            assert_eq!(next, br#""valid""#);
        }
    }

    #[test]
    fn framing_counts_multibyte_unicode_as_bytes() {
        let body = r#"{"id":"éあ😀\uFFFD","method":"m"}"#.as_bytes();
        let mut wire = Vec::new();
        write_message(&mut wire, body).unwrap();
        assert!(wire.starts_with(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()));
        let mut reader = BufReader::new(Drip {
            data: &wire,
            pos: 0,
        });
        let framed_body = read_message(&mut reader).unwrap().unwrap();
        assert_eq!(framed_body, body);
        let message = parse(std::str::from_utf8(&framed_body).unwrap()).unwrap();
        assert_eq!(message.get("id").unwrap().as_str(), Some("éあ😀�"));
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
    fn exact_lsp_integers_accept_decimal_equivalents_without_rounding() {
        let accepted = [
            ("-0", 0),
            ("1.0", 1),
            ("1e0", 1),
            ("0.1e1", 1),
            ("1000e-3", 1),
            ("2.147483647e9", i32::MAX),
            ("-2.147483648e9", i32::MIN),
            ("0e999999999999999999999", 0),
            ("21474836470e-1", i32::MAX),
        ];
        for (raw, expected) in accepted {
            assert_eq!(integer_value(&parse(raw).unwrap()), Some(expected), "{raw}");
        }
        for raw in [
            "1.0000000000000000001",
            "2147483648",
            "-2147483649",
            "1e-1000",
            "21474836480e-1",
            "1e999999999999999999999",
        ] {
            assert_eq!(integer_value(&parse(raw).unwrap()), None, "{raw}");
        }
    }

    #[test]
    fn envelopes_reject_reserved_duplicates_and_preserve_safe_correlation() {
        for key in ["jsonrpc", "method", "params"] {
            let duplicate = match key {
                "jsonrpc" => r#""jsonrpc":"2.0""#,
                "method" => r#""method":"m""#,
                _ => r#""params":{}"#,
            };
            let message = parse(&format!(
                r#"{{"jsonrpc":"2.0","id":1e0,"method":"m","params":{{}},{duplicate}}}"#
            ))
            .unwrap();
            assert_eq!(
                parse_call(&message).unwrap_err().id,
                Some(Json::Num("1e0".into()))
            );
        }
        let message = parse(r#"{"jsonrpc":"2.0","id":1,"\u0069d":2,"method":"m"}"#).unwrap();
        assert!(parse_call(&message).unwrap_err().id.is_none());
        for raw in [
            r#"{"id":1.0,"method":"m"}"#,
            r#"{"jsonrpc":"1.0","id":1.0,"method":"m"}"#,
            r#"{"jsonrpc":"2.0","id":1.0,"method":false}"#,
            r#"{"jsonrpc":"2.0","id":1.0,"method":"m","params":true}"#,
        ] {
            assert_eq!(
                parse_call(&parse(raw).unwrap()).unwrap_err().id,
                Some(Json::Num("1.0".into()))
            );
        }
        for id in ["null", "true", "{}", "[]", "1.5", "2147483648"] {
            let message = parse(&format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"m"}}"#)).unwrap();
            assert!(parse_call(&message).unwrap_err().id.is_none(), "{id}");
        }
        assert!(
            parse_call(&parse(r#"{"jsonrpc":"2.0","method":"m","x":1,"x":2}"#).unwrap()).is_ok()
        );
        let omitted =
            parse_call(&parse(r#"{"jsonrpc":"2.0","method":"shutdown"}"#).unwrap()).unwrap();
        assert!(omitted.id.is_none() && omitted.params.is_none());
        let null =
            parse_call(&parse(r#"{"jsonrpc":"2.0","method":"shutdown","params":null}"#).unwrap())
                .unwrap();
        assert_eq!(null.params, Some(Json::Null));
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
        let call =
            parse_call(&parse(r#"{"jsonrpc":"2.0","method":"m","params":[1]}"#).unwrap()).unwrap();
        assert!(call.id.is_none() && call.method == "m");
    }
}
