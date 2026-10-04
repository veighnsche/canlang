//! Dependency-free JSON value model: full-grammar parser plus compact renderer.
//!
//! Shared by the LSP transport and the producer-catalog loader. Object
//! members keep insertion order; numbers keep their raw lexeme so values
//! round-trip byte-identically. Parsing enforces [`MAX_JSON_DEPTH`] so
//! hostile input cannot recurse without bound.

use std::fmt;

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
