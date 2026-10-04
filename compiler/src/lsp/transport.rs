//! Dependency-free LSP stdio transport: Content-Length framing plus the
//! minimal JSON value model sufficient for LSP messages.
//!
//! [`read_message`] tolerates arbitrarily split reads (any [`BufRead`]
//! chunking, including one byte at a time) and accepts `CRLF` or bare `LF`
//! header endings. [`Json`] parses the full JSON grammar (nested objects,
//! arrays, all escapes including `\u` surrogate pairs, number lexemes) with
//! a nesting cap so hostile input cannot recurse without bound.

use std::fmt;
use std::io::{self, BufRead, Write};

/// Maximum JSON-RPC body accepted (64 MiB); larger frames are rejected.
pub const MAX_MESSAGE_BYTES: usize = 64 << 20;

/// Maximum JSON nesting depth accepted by [`parse`].
pub const MAX_JSON_DEPTH: usize = 64;

/// Minimal JSON value sufficient for LSP messages.
///
/// Object members keep insertion order; numbers keep their raw lexeme so
/// request ids round-trip byte-identically.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    /// JSON `null`.
    Null,
    /// JSON boolean.
    Bool(bool),
    /// Raw number lexeme, e.g. `3`, `-1.5e2`.
    Num(String),
    /// Decoded string.
    Str(String),
    /// JSON array.
    Arr(Vec<Json>),
    /// JSON object as ordered key/value pairs.
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// Look up an object member by key.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Borrow as a string, if it is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Copy as a bool, if it is one.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Parse as an integer (JSON numbers without fraction/exponent, in range).
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Num(lexeme) => {
                if lexeme.bytes().any(|b| b == b'.' || b == b'e' || b == b'E') {
                    return None;
                }
                lexeme.parse().ok()
            }
            _ => None,
        }
    }

    /// Borrow as an array, if it is one.
    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }
}

/// JSON parse failure with byte offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    /// Byte offset where parsing failed.
    pub offset: usize,
    /// Short static reason.
    pub message: &'static str,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid JSON at byte {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for ParseError {}

/// Parse one complete JSON document; trailing bytes are an error.
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    let value = parser.parse_value(0)?;
    parser.skip_ws();
    if parser.pos != parser.bytes.len() {
        return Err(parser.error("trailing bytes"));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn error(&self, message: &'static str) -> ParseError {
        ParseError {
            offset: self.pos,
            message,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8, message: &'static str) -> Result<(), ParseError> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.error(message))
        }
    }

    fn parse_value(&mut self, depth: usize) -> Result<Json, ParseError> {
        if depth > MAX_JSON_DEPTH {
            return Err(self.error("nesting too deep"));
        }
        self.skip_ws();
        match self.peek() {
            Some(b'n') => self.parse_literal("null", Json::Null),
            Some(b't') => self.parse_literal("true", Json::Bool(true)),
            Some(b'f') => self.parse_literal("false", Json::Bool(false)),
            Some(b'"') => Ok(Json::Str(self.parse_string()?)),
            Some(b'[') => {
                self.pos += 1;
                let mut items = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Ok(Json::Arr(items));
                }
                loop {
                    items.push(self.parse_value(depth + 1)?);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                            self.skip_ws();
                        }
                        Some(b']') => {
                            self.pos += 1;
                            return Ok(Json::Arr(items));
                        }
                        _ => return Err(self.error("expected ',' or ']'")),
                    }
                }
            }
            Some(b'{') => {
                self.pos += 1;
                let mut members = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Ok(Json::Obj(members));
                }
                loop {
                    self.skip_ws();
                    if self.peek() != Some(b'"') {
                        return Err(self.error("expected string key"));
                    }
                    let key = self.parse_string()?;
                    self.skip_ws();
                    self.expect(b':', "expected ':'")?;
                    let value = self.parse_value(depth + 1)?;
                    members.push((key, value));
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b'}') => {
                            self.pos += 1;
                            return Ok(Json::Obj(members));
                        }
                        _ => return Err(self.error("expected ',' or '}'")),
                    }
                }
            }
            Some(b'-') | Some(b'0'..=b'9') => Ok(Json::Num(self.parse_number()?)),
            Some(_) => Err(self.error("unexpected character")),
            None => Err(self.error("unexpected end")),
        }
    }

    fn parse_literal(&mut self, word: &str, value: Json) -> Result<Json, ParseError> {
        if self.bytes[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err(self.error("invalid literal"))
        }
    }

    fn parse_string(&mut self) -> Result<String, ParseError> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.pos += 1;
        let mut out = String::new();
        loop {
            let byte = self
                .peek()
                .ok_or_else(|| self.error("unterminated string"))?;
            match byte {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let esc = self
                        .peek()
                        .ok_or_else(|| self.error("unterminated escape"))?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let high = self.parse_hex4()?;
                            if (0xD800..0xDC00).contains(&high) {
                                if self.bytes.get(self.pos..self.pos + 2) == Some(b"\\u") {
                                    self.pos += 2;
                                    let low = self.parse_hex4()?;
                                    if (0xDC00..0xE000).contains(&low) {
                                        let scalar =
                                            0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                                        out.push(
                                            char::from_u32(scalar)
                                                .ok_or_else(|| self.error("invalid code point"))?,
                                        );
                                    } else {
                                        return Err(self.error("invalid low surrogate"));
                                    }
                                } else {
                                    return Err(self.error("missing low surrogate"));
                                }
                            } else if (0xDC00..0xE000).contains(&high) {
                                return Err(self.error("lone low surrogate"));
                            } else {
                                out.push(
                                    char::from_u32(high)
                                        .ok_or_else(|| self.error("invalid code point"))?,
                                );
                            }
                        }
                        _ => return Err(self.error("invalid escape")),
                    }
                }
                0x00..=0x1F => return Err(self.error("unescaped control character")),
                0x20..=0x7F => {
                    out.push(byte as char);
                    self.pos += 1;
                }
                _ => {
                    // Copy one multibyte UTF-8 scalar verbatim. The parser
                    // input is already a `&str`, so the scalar at `pos` is
                    // valid; decode from the lead byte in O(1) without
                    // revalidating the tail (a whole-tail `from_utf8` here
                    // would be O(n) per scalar, O(n^2) per string).
                    let width = utf8_width(byte).ok_or_else(|| self.error("invalid UTF-8"))?;
                    let end = self.pos + width;
                    let slice = self
                        .bytes
                        .get(self.pos..end)
                        .ok_or_else(|| self.error("invalid UTF-8"))?;
                    let text =
                        std::str::from_utf8(slice).map_err(|_| self.error("invalid UTF-8"))?;
                    let ch = text
                        .chars()
                        .next()
                        .ok_or_else(|| self.error("invalid UTF-8"))?;
                    out.push(ch);
                    self.pos = end;
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u32, ParseError> {
        if self.pos + 4 > self.bytes.len() {
            return Err(self.error("truncated \\u escape"));
        }
        let mut value: u32 = 0;
        for i in 0..4 {
            let digit = match self.bytes[self.pos + i] {
                b'0'..=b'9' => (self.bytes[self.pos + i] - b'0') as u32,
                b'a'..=b'f' => (self.bytes[self.pos + i] - b'a') as u32 + 10,
                b'A'..=b'F' => (self.bytes[self.pos + i] - b'A') as u32 + 10,
                _ => return Err(self.error("invalid \\u escape")),
            };
            value = value * 16 + digit;
        }
        self.pos += 4;
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<String, ParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
            }
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.error("invalid number")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.error("invalid number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        Ok(String::from_utf8_lossy(&self.bytes[start..self.pos]).into_owned())
    }
}

/// UTF-8 scalar width in bytes from the lead byte, or `None` for a
/// stray continuation byte. Overlong/invalid sequences are rejected by
/// the `from_utf8` check on the sliced scalar in [`Parser::parse_string`].
fn utf8_width(lead: u8) -> Option<usize> {
    if lead < 0x80 {
        Some(1)
    } else if lead >> 5 == 0b110 {
        Some(2)
    } else if lead >> 4 == 0b1110 {
        Some(3)
    } else if lead >> 3 == 0b11110 {
        Some(4)
    } else {
        None
    }
}

/// Render a value as compact JSON.
pub fn render(value: &Json) -> String {
    let mut out = String::new();
    render_into(&mut out, value);
    out
}

fn render_into(out: &mut String, value: &Json) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Num(lexeme) => out.push_str(lexeme),
        Json::Str(s) => crate::diagnostic::push_json_str(out, s),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_into(out, item);
            }
            out.push(']');
        }
        Json::Obj(members) => {
            out.push('{');
            for (i, (key, value)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                crate::diagnostic::push_json_str(out, key);
                out.push(':');
                render_into(out, value);
            }
            out.push('}');
        }
    }
}

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
