//! Ordered JSON input model and compatible typed output adapters.
//!
//! Shared by the LSP transport and the producer-catalog loader. Object
//! members keep insertion order; numbers keep their raw lexeme so values
//! round-trip byte-identically. Parsing enforces [`MAX_JSON_DEPTH`] so
//! hostile input cannot recurse without bound.

use serde::de::{self, Deserialize, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use std::{cell::Cell, fmt, io};

/// Serialize typed output with Can's compact, byte-compatible string policy.
///
/// Struct declarations and ordered sequence/map serializers own field order;
/// strings and exact wire values must not pass through floating-point values.
/// Generic serializers report errors rather than substituting null/empty output.
/// Closed compiler DTOs retain their existing infallible String adapters and
/// treat an unexpected serialization failure as an internal tool error.
pub fn to_compact_string<T: serde::Serialize + ?Sized>(
    value: &T,
) -> Result<String, serde_json::Error> {
    to_string_with_formatter(value, CanCompactFormatter)
}

/// Serializer-family layout adapters delegate value emission to serde_json.
pub(crate) fn to_string_with_formatter<
    T: serde::Serialize + ?Sized,
    F: serde_json::ser::Formatter,
>(
    value: &T,
    formatter: F,
) -> Result<String, serde_json::Error> {
    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    value.serialize(&mut serializer)?;
    Ok(String::from_utf8(bytes).expect("JSON serialization must produce UTF-8"))
}

/// The only escape-policy overrides; all string scanning belongs to serde_json.
pub(crate) fn write_compatible_escape<W: ?Sized + std::io::Write>(
    writer: &mut W,
    escape: serde_json::ser::CharEscape,
) -> std::io::Result<()> {
    use serde_json::ser::{CharEscape, CompactFormatter, Formatter};
    match escape {
        CharEscape::Backspace => writer.write_all(b"\\u0008"),
        CharEscape::FormFeed => writer.write_all(b"\\u000c"),
        other => CompactFormatter.write_char_escape(writer, other),
    }
}

struct CanCompactFormatter;
impl serde_json::ser::Formatter for CanCompactFormatter {
    fn write_char_escape<W: ?Sized + std::io::Write>(
        &mut self,
        writer: &mut W,
        escape: serde_json::ser::CharEscape,
    ) -> std::io::Result<()> {
        write_compatible_escape(writer, escape)
    }
}

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
    /// Zero-based UTF-8 byte that triggered failure, or input length at EOF.
    pub offset: usize,
    /// Native grammar reason without a redundant line/column suffix.
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid JSON at byte {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for ParseError {}

/// Parse one complete JSON document; trailing bytes are an error.
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let cursor = Cell::new(0);
    let error_offset = Cell::new(None);
    let eof = Cell::new(false);
    let seed = InputSeed {
        text,
        cursor: &cursor,
        eof: &eof,
        error_offset: &error_offset,
        depth: 0,
        origin: ValueOrigin::Root,
    };
    let mut deserializer = serde_json::Deserializer::from_reader(InputReader {
        bytes: text.as_bytes(),
        cursor: &cursor,
        eof: &eof,
    });
    let result = seed.deserialize(&mut deserializer).and_then(|value| {
        seed.capture_error(deserializer.end())?;
        Ok(value)
    });
    result.map_err(|error| {
        // Capture at the first fallible seed/access boundary. Serde may
        // consume whitespace/delimiters while unwinding a failed container;
        // the final reader cursor/EOF state no longer identifies that error.
        let offset = error_offset
            .get()
            .expect("JSON failure must capture its byte");
        let native = error.to_string();
        let suffix = format!(" at line {} column {}", error.line(), error.column());
        ParseError {
            offset,
            message: native.strip_suffix(&suffix).unwrap_or(&native).to_owned(),
        }
    })
}

/// Cursor coupling qualified against pinned serde_json 1.0.151:
/// IoRead uses one-byte reads and holds at most one peeked byte. SeqAccess
/// peeks the next value before invoking its seed; MapAccess consumes only the
/// colon before invoking its value seed. Root has not fetched a byte yet.
/// Requalify these rules on upgrades with the context/EOF/depth witnesses below.
#[derive(Clone, Copy)]
enum ValueOrigin {
    Root,
    Object,
    Array,
}

struct InputReader<'a> {
    bytes: &'a [u8],
    cursor: &'a Cell<usize>,
    eof: &'a Cell<bool>,
}

impl io::Read for InputReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let position = self.cursor.get();
        // Do not permit a bulk request to scan past the active parse entry.
        if output.is_empty() {
            return Ok(0);
        }
        if position == self.bytes.len() {
            self.eof.set(true);
            return Ok(0);
        }
        output[0] = self.bytes[position];
        self.cursor.set(position + 1);
        Ok(1)
    }
}

#[derive(Clone, Copy)]
struct InputSeed<'a> {
    text: &'a str,
    cursor: &'a Cell<usize>,
    eof: &'a Cell<bool>,
    error_offset: &'a Cell<Option<usize>>,
    depth: usize,
    origin: ValueOrigin,
}

impl InputSeed<'_> {
    fn entry_offset(self) -> usize {
        match self.origin {
            ValueOrigin::Root | ValueOrigin::Object => self.cursor.get(),
            ValueOrigin::Array => self.cursor.get().saturating_sub(1),
        }
    }

    fn capture_error<T, E>(self, result: Result<T, E>) -> Result<T, E> {
        result.inspect_err(|_| {
            if self.error_offset.get().is_none() {
                self.error_offset.set(Some(if self.eof.get() {
                    self.cursor.get()
                } else {
                    self.cursor.get().saturating_sub(1)
                }));
            }
        })
    }

    fn child(self, origin: ValueOrigin) -> Self {
        Self {
            depth: self.depth + 1,
            origin,
            ..self
        }
    }
}

impl<'de> DeserializeSeed<'de> for InputSeed<'_> {
    type Value = Json;

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Json, D::Error> {
        let mut start = self.entry_offset();
        // Enforce the value-entry limit before visiting/materializing the value.
        // SeqAccess may already skip whitespace and peek its first byte;
        // object values have only consumed the colon. Empty containers at
        // depth64 never enter a child.
        if self.depth > MAX_JSON_DEPTH {
            self.error_offset.set(Some(start));
            return Err(de::Error::custom("nesting too deep"));
        }
        let bytes = self.text.as_bytes();
        while matches!(bytes.get(start), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            start += 1;
        }
        if matches!(bytes.get(start), Some(b'-' | b'0'..=b'9')) {
            // Only numeric tokens use ignored parsing. Serde owns their full
            // grammar without floats, magnitude limits, or synthetic map keys.
            // Containers and strings always visit below: ignoring a subtree
            // would bypass both the depth budget and strict surrogate decoding.
            self.capture_error(de::IgnoredAny::deserialize(deserializer))?;
            let fetched = self.cursor.get();
            // A successful number ends with a digit. Otherwise IoRead fetched
            // one delimiter as lookahead; exclude it from the authored lexeme.
            let end = fetched - usize::from(!bytes[fetched - 1].is_ascii_digit());
            Ok(Json::Num(self.text[start..end].to_owned()))
        } else {
            self.capture_error(deserializer.deserialize_any(self))
        }
    }
}

impl<'de> Visitor<'de> for InputSeed<'_> {
    type Value = Json;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Json, E> {
        Ok(Json::Bool(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Json, E> {
        Ok(Json::Str(value.to_owned()))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(value) =
            self.capture_error(sequence.next_element_seed(self.child(ValueOrigin::Array)))?
        {
            items.push(value);
        }
        Ok(Json::Arr(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Json, A::Error> {
        let mut members = Vec::new();
        while let Some(key) = self.capture_error(object.next_key::<String>())? {
            let value =
                self.capture_error(object.next_value_seed(self.child(ValueOrigin::Object)))?;
            members.push((key, value));
        }
        Ok(Json::Obj(members))
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

