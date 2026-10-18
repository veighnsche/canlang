//! Versioned JSON operation transport for the native conformance runner.
//!
//! Request: `{"v":1,"op":"<name>","args":[...]}`. BigInts travel as signed
//! decimal ASCII; decimals/money/dates/datetimes as tagged coefficient
//! tuples; JS numbers as JSON numbers (or `"NaN"`/`"Infinity"`/`"-Infinity"`
//! strings). Conversion cost is counted by the differential, not hidden.
//!
//! Inputs decode to `Value::Record` for structural carriers WITHOUT
//! validation, so core guards observe them exactly like the TypeScript
//! guards observe arbitrary objects (malformed shapes reach the op's own
//! error, never a transport error). Malformed transport bytes are the only
//! transport errors and indicate a differential bug, never Can behavior.
//! Hygiene: record entries must not repeat a key (JS objects cannot), and
//! keys that would reorder under JS integer-index rules are avoided.
//! Duplicate entry keys are refused before operation guards run.
//!
//! Response: `{"ok":true,"value":...}` on success;
//! `{"ok":false,"code":...,"message":...}` on a Can failure;
//! `{"ok":false,"violations":[...]}` on a codec decode failure;
//! `{"ok":false,"transport":...}` on malformed transport input.

use num_bigint::BigInt;
use serde_json::Value as Json;
use std::collections::HashSet;

use crate::codecs::numeric::{decode_value_scalar, encode_value_scalar, ScalarName, WireValue};
use crate::failures::Failure;
use crate::representations::numeric::Value;
use crate::representations::numeric::{
    is_currency_shape, is_date_value, is_datetime_value, is_decimal_value, is_money_value,
};

/// Transport ABI version. Bumped only by a coordinated C03-style revision.
pub const ABI_VERSION: u32 = 1;

/// Selected int/ASCII admission: the released named CSV raw/text bound
/// (1 MiB, mirroring the Interfaces `JSON_BODY_MAX_BYTES` admission). The
/// selected TypeScript caller checks the original ASCII text against this
/// bound before tag/JSON/string allocations; the encoded request bound below
/// is what this transport enforces before serde parsing.
pub const SELECTED_INT_TEXT_MAX_BYTES: usize = 1_048_576;

/// Worst-case ASCII JSON-escape expansion: every admitted byte is a C0
/// control needing a six-byte `\u00xx` escape.
const SELECTED_ESCAPE_WORST_CASE: usize = 6;

/// Byte length of the fixed two-scalar `decode-value` envelope carrying an
/// empty string payload, i.e.
/// `{"v":1,"op":"decode-value","args":[{"t":"str","v":"int"},{"t":"str","v":""}]}`
/// (77 bytes, verified against the TypeScript caller's `JSON.stringify`
/// of the same tagged shape). The `encode-value` envelope is shorter and
/// its bigint payloads are small, so the decode shape with a maximum
/// escaped text dominates every compliant selected request.
const SELECTED_ENVELOPE_EMPTY_LEN: usize = 77;

/// Derived encoded-request bound, enforced ONLY on recognized selected int
/// calls (empty-envelope bytes plus worst-case escape expansion of a
/// maximum admitted text), and only AFTER the borrow-only pre-serde scan
/// admits them. Compliant selected callers always fit; anything larger
/// refuses as a transport fault with no accepted result, effect, or
/// fallback. This reuses the released CSV admission (it is larger, never a
/// new smaller global quota). Non-selected calls never see this bound:
/// they keep the exact pre-admission legacy order and verdicts at every
/// size serde itself accepts.
pub const SELECTED_REQUEST_MAX_BYTES: usize =
    SELECTED_ENVELOPE_EMPTY_LEN + SELECTED_INT_TEXT_MAX_BYTES * SELECTED_ESCAPE_WORST_CASE;

/// Exact keys admitted on the top-level selected request envelope.
const SELECTED_ENVELOPE_KEYS: [&str; 3] = ["v", "op", "args"];

/// Exact keys admitted on a selected tagged scalar argument.
const SELECTED_TAG_KEYS: [&str; 2] = ["t", "v"];

fn transport_refused(message: String) -> Json {
    serde_json::json!({"ok": false, "transport": message})
}

fn exact_keys(value: &Json, keys: &[&str]) -> bool {
    match value.as_object() {
        Some(map) => {
            if map.len() != keys.len() {
                return false;
            }
            keys.iter().all(|key| map.contains_key(*key))
        }
        None => false,
    }
}

fn selected_tag<'a>(value: &'a Json, tag: &str) -> Option<&'a str> {
    if !exact_keys(value, &SELECTED_TAG_KEYS) {
        return None;
    }
    if value.get("t")?.as_str()? != tag {
        return None;
    }
    value.get("v")?.as_str()
}

/// Loose candidate peek: does this raw argument look like the tagged
/// `"int"` scalar carrier, ignoring any extra keys? Extra keys never
/// clear selection here; the strict exact-keys enforcement below
/// refuses them as transport instead of letting a malformed first tag
/// escape to the legacy decode order.
fn selected_scalar_hint(value: &Json) -> bool {
    value.get("t").and_then(Json::as_str) == Some("str")
        && value.get("v").and_then(Json::as_str) == Some("int")
}

/// Significant-digit scan shared with the codec: strips an optional
/// minus and leading zeros. Returns the significant digits, or `None`
/// when the text is not optional-minus plus ASCII digits.
fn significant_digits(text: &str) -> Option<&str> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(digits.trim_start_matches('0'))
}

/// Lexical 19-significant-digit signed64 check: equal-length
/// lexicographic comparison is numeric, so no bigint parse is needed.
fn significant_above_int64(text: &str, significant: &str) -> bool {
    if significant.len() != 19 {
        return false;
    }
    let limit = if text.starts_with('-') {
        INT64_NEGATIVE_19
    } else {
        INT64_POSITIVE_19
    };
    significant > limit
}

/// Outcome of a short-token decode: fits in the fixed buffer, is
/// well-formed but longer than any admitted name, or is malformed.
#[derive(PartialEq, Eq)]
enum Short {
    Fit(usize),
    TooLong,
    Bad,
}

/// Canonical int64 carrier analysis of a raw string span: fits the
/// canonical shape, exceeds the carrier length, is out of signed64 range
/// (lexically, without any bigint parse), or is not optional-minus plus
/// ASCII digits (legacy verdicts decide those).
#[derive(PartialEq, Eq)]
enum IntLex {
    Fits,
    CarrierTooLong,
    OutOfRange,
    Unparseable,
}

/// Canonical signed64 decimal text is at most 20 characters
/// (`-9223372036854775808`). The selected encode caller serializes an
/// actual signed64 bigint canonically, so anything longer cannot come
/// from that caller and refuses before any bigint parse.
const ENCODE_INT_CANONICAL_MAX_CHARS: usize = 20;

/// Lexical 19-digit signed64 limits (same values as the codec's
/// `decode_int64`): equal-length lexicographic comparison is numeric.
const INT64_POSITIVE_19: &str = "9223372036854775807";
const INT64_NEGATIVE_19: &str = "9223372036854775808";

/// Outcome of the pre-serde selected-shape scan over raw request bytes.
/// The scan borrows only: it measures decoded lengths and significant
/// magnitudes without allocating any payload string or bigint.
enum Preserde {
    /// Not a recognizable selected int call: keep the legacy path
    /// (serde parse bounded by the outer cap, existing verdicts).
    Legacy,
    /// Recognized selected int call within all pre-serde bounds:
    /// proceed to serde plus the post-serde strict gate.
    Admitted,
    /// Recognized selected int call violating a pre-serde bound: refuse
    /// now, before any serde allocation or bigint parse.
    Refused(Json),
}

struct Cur<'a> {
    b: &'a [u8],
    s: &'a str,
    p: usize,
}

impl<'a> Cur<'a> {
    fn ws(&mut self) {
        while self.p < self.b.len() && matches!(self.b[self.p], b' ' | b'\t' | b'\n' | b'\r') {
            self.p += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.b.get(self.p) == Some(&c) {
            self.p += 1;
            true
        } else {
            false
        }
    }

    /// Parses one JSON string token; returns its raw span (including the
    /// quotes) with all escapes validated. Anything else (or malformed
    /// escapes, raw control bytes) yields `None`.
    fn str_span(&mut self) -> Option<(usize, usize)> {
        if self.b.get(self.p) != Some(&b'"') {
            return None;
        }
        let start = self.p;
        self.p += 1;
        while self.p < self.b.len() {
            match self.b[self.p] {
                b'"' => {
                    self.p += 1;
                    return Some((start, self.p));
                }
                b'\\' => {
                    self.p += 1;
                    match self.b.get(self.p) {
                        Some(b'"') | Some(b'\\') | Some(b'/') | Some(b'b') | Some(b'f')
                        | Some(b'n') | Some(b'r') | Some(b't') => {
                            self.p += 1;
                        }
                        Some(b'u') => {
                            self.p += 1;
                            for _ in 0..4 {
                                if !matches!(self.b.get(self.p), Some(c) if c.is_ascii_hexdigit()) {
                                    return None;
                                }
                                self.p += 1;
                            }
                        }
                        _ => return None,
                    }
                }
                c if c < 0x20 => return None,
                _ => {
                    self.p += 1;
                }
            }
        }
        None
    }

    fn hex_val(c: u8) -> Option<u32> {
        match c {
            b'0'..=b'9' => Some((c - b'0') as u32),
            b'a'..=b'f' => Some((c - b'a' + 10) as u32),
            b'A'..=b'F' => Some((c - b'A' + 10) as u32),
            _ => None,
        }
    }

    /// Decodes one `\uXXXX` escape at `pos` (pos points past `\u`);
    /// advances past it. Handles astral pairs.
    fn hex_unit(b: &[u8], pos: &mut usize) -> Option<char> {
        if *pos + 4 > b.len() {
            return None;
        }
        let mut unit: u32 = 0;
        for i in 0..4 {
            unit = unit * 16 + Self::hex_val(b[*pos + i])?;
        }
        *pos += 4;
        let lead = char::from_u32(unit)?;
        if !(0xD800..0xDC00).contains(&unit) {
            return Some(lead);
        }
        if b.get(*pos) != Some(&b'\\') || b.get(*pos + 1) != Some(&b'u') {
            return None;
        }
        *pos += 2;
        if *pos + 4 > b.len() {
            return None;
        }
        let mut low: u32 = 0;
        for i in 0..4 {
            low = low * 16 + Self::hex_val(b[*pos + i])?;
        }
        *pos += 4;
        if !(0xDC00..0xE000).contains(&low) {
            return None;
        }
        char::from_u32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00))
    }

    /// Next decoded unit of a string content span (`start..end` excludes
    /// the quotes); advances `pos`. Returns `None` on invalid escapes
    /// or lone surrogates. The source is already valid UTF-8, so raw
    /// units decode from the lead byte alone without revalidating the
    /// tail (a per-char revalidation would be quadratic on megabyte
    /// payloads); every position stays on a char boundary because
    /// escapes consume whole units.
    fn next_unit(s: &str, b: &[u8], pos: &mut usize, end: usize) -> Option<char> {
        if *pos >= end {
            return None;
        }
        let c = b[*pos];
        if c != b'\\' {
            let ch = s[*pos..end].chars().next()?;
            *pos += ch.len_utf8();
            return Some(ch);
        }
        *pos += 1;
        match b.get(*pos) {
            Some(b'"') => {
                *pos += 1;
                Some('"')
            }
            Some(b'\\') => {
                *pos += 1;
                Some('\\')
            }
            Some(b'/') => {
                *pos += 1;
                Some('/')
            }
            Some(b'b') => {
                *pos += 1;
                Some('\u{8}')
            }
            Some(b'f') => {
                *pos += 1;
                Some('\u{c}')
            }
            Some(b'n') => {
                *pos += 1;
                Some('\n')
            }
            Some(b'r') => {
                *pos += 1;
                Some('\r')
            }
            Some(b't') => {
                *pos += 1;
                Some('\t')
            }
            Some(b'u') => {
                *pos += 1;
                Self::hex_unit(b, pos)
            }
            _ => None,
        }
    }

    /// Decodes a short token (key, op, tag name) into `buf`. A well-formed
    /// token that does not fit reports `TooLong` (it is definitely not one
    /// of the short admitted names) instead of failing the whole scan;
    /// malformed escapes report `Bad` and keep the legacy serde verdicts.
    fn decode_short(&self, span: (usize, usize), buf: &mut [u8; 64]) -> Short {
        let mut pos = span.0 + 1;
        let end = span.1 - 1;
        let mut len = 0;
        while pos < end {
            let ch = match Self::next_unit(self.s, self.b, &mut pos, end) {
                Some(ch) => ch,
                None => return Short::Bad,
            };
            let mut tmp = [0u8; 4];
            let bytes = ch.encode_utf8(&mut tmp).as_bytes();
            if len + bytes.len() > buf.len() {
                return Short::TooLong;
            }
            buf[len..len + bytes.len()].copy_from_slice(bytes);
            len += bytes.len();
        }
        Short::Fit(len)
    }

    /// Decoded UTF-8 byte length of a string content span; `None` on
    /// invalid escapes.
    fn content_ulen(&self, span: (usize, usize)) -> Option<usize> {
        let mut pos = span.0 + 1;
        let end = span.1 - 1;
        let mut len = 0usize;
        while pos < end {
            len += Self::next_unit(self.s, self.b, &mut pos, end)?.len_utf8();
        }
        Some(len)
    }

    /// Significant-digit analysis of a string content span for the
    /// bigint magnitude gate: an optional leading minus, then ASCII
    /// digits with leading zeros stripped. Returns the significant
    /// count capped at 20, or `None` when the span is not
    /// optional-minus plus ASCII digits (legacy fast-fails those).
    fn content_sig(&self, span: (usize, usize)) -> Option<usize> {
        let mut pos = span.0 + 1;
        let end = span.1 - 1;
        if pos < end && self.b[pos] == b'-' {
            pos += 1;
        }
        let mut digits = 0usize;
        let mut significant = 0usize;
        let mut leading = true;
        while pos < end {
            let ch = Self::next_unit(self.s, self.b, &mut pos, end)?;
            if !ch.is_ascii_digit() {
                return None;
            }
            digits += 1;
            if leading && ch == '0' {
                continue;
            }
            leading = false;
            significant += 1;
            if significant > 20 {
                return Some(significant);
            }
        }
        if digits == 0 {
            return None;
        }
        Some(significant)
    }

    /// Canonical int64 carrier analysis of a string content span, borrowing
    /// only: decoded character count, optional-minus plus ASCII-digit
    /// grammar, significant-digit count with a lexical 19-digit signed64
    /// comparison. No payload string and no bigint parse at any size.
    fn content_int64(&self, span: (usize, usize)) -> IntLex {
        let mut pos = span.0 + 1;
        let end = span.1 - 1;
        let mut chars = 0usize;
        let mut neg = false;
        if pos < end && self.b[pos] == b'-' {
            neg = true;
            pos += 1;
            chars += 1;
        }
        let mut significant = [0u8; 19];
        let mut count = 0usize;
        let mut digits = 0usize;
        let mut leading = true;
        while pos < end {
            let ch = match Self::next_unit(self.s, self.b, &mut pos, end) {
                Some(ch) => ch,
                None => return IntLex::Unparseable,
            };
            if !ch.is_ascii_digit() {
                return IntLex::Unparseable;
            }
            chars += 1;
            if chars > ENCODE_INT_CANONICAL_MAX_CHARS {
                return IntLex::CarrierTooLong;
            }
            digits += 1;
            if leading && ch == '0' {
                continue;
            }
            leading = false;
            if count >= 19 {
                return IntLex::OutOfRange;
            }
            significant[count] = ch as u8;
            count += 1;
        }
        if digits == 0 {
            return IntLex::Unparseable;
        }
        if count < 19 {
            return IntLex::Fits;
        }
        let limit = if neg {
            INT64_NEGATIVE_19
        } else {
            INT64_POSITIVE_19
        };
        if &significant[..] > limit.as_bytes() {
            return IntLex::OutOfRange;
        }
        IntLex::Fits
    }

    /// Skips one arbitrary JSON value; `false` on malformed input.
    /// Recursion is depth-capped: deeper input falls back to the legacy
    /// path, where serde's own recursion limit refuses it safely.
    fn skip_value(&mut self) -> bool {
        self.skip_value_at(0)
    }

    fn skip_value_at(&mut self, depth: usize) -> bool {
        if depth > 64 {
            return false;
        }
        self.ws();
        match self.b.get(self.p) {
            Some(b'"') => self.str_span().is_some(),
            Some(b'{') => {
                self.p += 1;
                self.ws();
                if self.eat(b'}') {
                    return true;
                }
                loop {
                    if self.str_span().is_none() {
                        return false;
                    }
                    self.ws();
                    if !self.eat(b':') {
                        return false;
                    }
                    if !self.skip_value_at(depth + 1) {
                        return false;
                    }
                    self.ws();
                    if self.eat(b',') {
                        self.ws();
                        continue;
                    }
                    return self.eat(b'}');
                }
            }
            Some(b'[') => {
                self.p += 1;
                self.ws();
                if self.eat(b']') {
                    return true;
                }
                loop {
                    if !self.skip_value_at(depth + 1) {
                        return false;
                    }
                    self.ws();
                    if self.eat(b',') {
                        self.ws();
                        continue;
                    }
                    return self.eat(b']');
                }
            }
            Some(b't') => self.eat_lit("true"),
            Some(b'f') => self.eat_lit("false"),
            Some(b'n') => self.eat_lit("null"),
            Some(c) if c.is_ascii_digit() || *c == b'-' => {
                while self.p < self.b.len()
                    && matches!(self.b[self.p], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
                {
                    self.p += 1;
                }
                true
            }
            _ => false,
        }
    }

    fn eat_lit(&mut self, lit: &str) -> bool {
        if self.b.len() >= self.p + lit.len() && &self.b[self.p..self.p + lit.len()] == lit.as_bytes() {
            self.p += lit.len();
            true
        } else {
            false
        }
    }
}

/// A parsed selected-candidate tag object: `t` short value, `v` string
/// span when string, whether any unknown field was present, and the raw
/// object span for nested magnitude walks.
struct TagShape {
    t_is: TagName,
    v_str: Option<(usize, usize)>,
    exact: bool,
    span: (usize, usize),
}

#[derive(PartialEq, Eq)]
enum TagName {
    Str,
    Bigint,
    Other,
}

/// Parses one tag object the cursor points at (`{` unconsumed).
/// Returns `None` when it is not shaped like an object at all; duplicate
/// or unknown keys are recorded as inexact rather than failing the scan.
fn parse_tag(c: &mut Cur) -> Option<TagShape> {
    let obj_start = c.p;
    if !c.eat(b'{') {
        return None;
    }
    let mut t: Option<TagName> = None;
    let mut v_str: Option<(usize, usize)> = None;
    let mut exact = true;
    let mut seen_t = false;
    let mut seen_v = false;
    let mut buf = [0u8; 64];
    c.ws();
    if c.eat(b'}') {
        return Some(TagShape {
            t_is: t?,
            v_str,
            exact,
            span: (obj_start, c.p),
        });
    }
    loop {
        c.ws();
        let span = c.str_span()?;
        // A well-formed key longer than any admitted name is simply not
        // `t`/`v`: the tag is inexact, and the scan keeps preflight
        // instead of escaping to the serde-first legacy path. Malformed
        // keys keep the legacy verdicts.
        let (is_t, is_v) = match c.decode_short(span, &mut buf) {
            Short::Fit(klen) => (buf[..klen] == *b"t", buf[..klen] == *b"v"),
            Short::TooLong => {
                exact = false;
                (false, false)
            }
            Short::Bad => return None,
        };
        c.ws();
        if !c.eat(b':') {
            return None;
        }
        c.ws();
        if is_t {
            if seen_t {
                exact = false;
            }
            seen_t = true;
            let vspan = c.str_span()?;
            // A well-formed tag name longer than any known tag is not
            // `str`/`bigint`: it selects the legacy order below rather
            // than escaping the whole candidate to it.
            t = Some(match c.decode_short(vspan, &mut buf) {
                Short::Fit(vlen) => match &buf[..vlen] {
                    b"str" => TagName::Str,
                    b"bigint" => TagName::Bigint,
                    _ => TagName::Other,
                },
                Short::TooLong => TagName::Other,
                Short::Bad => return None,
            });
        } else if is_v {
            if seen_v {
                exact = false;
            }
            seen_v = true;
            match c.str_span() {
                Some(vspan) => v_str = Some(vspan),
                None => {
                    if !c.skip_value() {
                        return None;
                    }
                }
            }
        } else {
            exact = false;
            if !c.skip_value() {
                return None;
            }
        }
        c.ws();
        if c.eat(b',') {
            continue;
        }
        if c.eat(b'}') {
            break;
        }
        return None;
    }
    let end = c.p;
    Some(TagShape {
        t_is: t?,
        v_str,
        exact,
        span: (obj_start, end),
    })
}

/// bigint-decimal carrying keys anywhere in a tag subtree: only these
/// positions ever reach arbitrary-precision parsing in the legacy
/// decoder, so only these are magnitude-gated.
fn is_bigint_key(key: &[u8]) -> bool {
    matches!(key, b"v" | b"coef" | b"minor" | b"ms")
}

/// Outcome of the nested magnitude walk.
#[derive(PartialEq, Eq)]
enum Walk {
    /// No bigint-decimal span above int64 magnitude found.
    Clean,
    /// A bigint-decimal span above int64 magnitude found: refuse
    /// before any parse.
    Huge,
    /// Span not shaped well enough to walk: keep legacy verdicts.
    Unparseable,
}

/// Walks a raw value span (cursor positioned at its start) looking for
/// bigint-decimal string spans above int64 magnitude. Borrows only, no
/// allocation and no bigint parse. Depth-capped; deeper input keeps
/// legacy verdicts (serde refuses it safely).
fn walk_nested(c: &mut Cur, depth: usize) -> Walk {
    if depth > 64 {
        return Walk::Unparseable;
    }
    c.ws();
    match c.b.get(c.p) {
        Some(b'{') => {
            c.p += 1;
            let mut buf = [0u8; 64];
            c.ws();
            if c.eat(b'}') {
                return Walk::Clean;
            }
            loop {
                c.ws();
                let span = match c.str_span() {
                    Some(span) => span,
                    None => return Walk::Unparseable,
                };
                // Any decoded string span above the selected text bound
                // refuses before serde materializes it, keys included:
                // no legitimate selected call carries megabyte strings,
                // and every smaller span keeps legacy verdicts byte for
                // byte. Malformed escapes keep the legacy verdicts.
                match c.content_ulen(span) {
                    Some(len) if len > SELECTED_INT_TEXT_MAX_BYTES => return Walk::Huge,
                    Some(_) => {}
                    None => return Walk::Unparseable,
                }
                // A well-formed key longer than any bigint-decimal key is
                // simply not one; malformed keys keep legacy verdicts.
                let bigkey = match c.decode_short(span, &mut buf) {
                    Short::Fit(klen) => is_bigint_key(&buf[..klen]),
                    Short::TooLong => false,
                    Short::Bad => return Walk::Unparseable,
                };
                c.ws();
                if !c.eat(b':') {
                    return Walk::Unparseable;
                }
                c.ws();
                if bigkey {
                    let save = c.p;
                    match c.str_span() {
                        Some(vspan) => {
                            // Oversized decimal text refuses even when its
                            // significant magnitude is small (a megabyte of
                            // leading zeros still materializes in serde).
                            match c.content_ulen(vspan) {
                                Some(len) if len > SELECTED_INT_TEXT_MAX_BYTES => {
                                    return Walk::Huge;
                                }
                                Some(_) => {}
                                None => {
                                    c.p = save;
                                    return Walk::Unparseable;
                                }
                            }
                            match c.content_sig(vspan) {
                                Some(significant) if significant > 19 => return Walk::Huge,
                                Some(_) => {}
                                None => {
                                    // Grammar failures fast-fail in the
                                    // legacy parse; keep its verdicts.
                                }
                            }
                        }
                        None => {
                            // Non-string bigint-key value: walk it in
                            // case it nests further carriers.
                            c.p = save;
                            match walk_nested(c, depth + 1) {
                                Walk::Clean => {}
                                other => return other,
                            }
                        }
                    }
                } else {
                    match walk_nested(c, depth + 1) {
                        Walk::Clean => {}
                        other => return other,
                    }
                }
                c.ws();
                if c.eat(b',') {
                    continue;
                }
                if c.eat(b'}') {
                    break;
                }
                return Walk::Unparseable;
            }
            Walk::Clean
        }
        Some(b'[') => {
            c.p += 1;
            c.ws();
            if c.eat(b']') {
                return Walk::Clean;
            }
            loop {
                match walk_nested(c, depth + 1) {
                    Walk::Clean => {}
                    other => return other,
                }
                c.ws();
                if c.eat(b',') {
                    continue;
                }
                if c.eat(b']') {
                    break;
                }
                return Walk::Unparseable;
            }
            Walk::Clean
        }
        _ => {
            // Atoms (bare strings, numbers, literals) never reach
            // bigint parsing without a tag carrier; validate shape only.
            // A bare string above the selected text bound still refuses
            // before serde materializes it; anything smaller keeps the
            // legacy verdicts byte for byte.
            if c.b.get(c.p) == Some(&b'"') {
                match c.str_span() {
                    Some(vspan) => match c.content_ulen(vspan) {
                        Some(len) if len > SELECTED_INT_TEXT_MAX_BYTES => Walk::Huge,
                        Some(_) => Walk::Clean,
                        None => Walk::Unparseable,
                    },
                    None => Walk::Unparseable,
                }
            } else if c.skip_value() {
                Walk::Clean
            } else {
                Walk::Unparseable
            }
        }
    }
}

/// Scans raw request bytes for a recognizable selected int call,
/// measuring decoded lengths and bigint magnitudes without allocating
/// either. Recognized selected shapes return `Admitted` (within bounds)
/// or `Refused` (transport, before serde); anything else returns
/// `Legacy` and keeps the existing serde-first order and verdicts.
fn preserde_selected_scan(line: &str) -> Preserde {
    let legacy = Preserde::Legacy;
    let mut c = Cur {
        b: line.as_bytes(),
        s: line,
        p: 0,
    };
    let mut buf = [0u8; 64];
    c.ws();
    if !c.eat(b'{') {
        return legacy;
    }
    let mut seen = [false; 3];
    let mut extra_top = false;
    let mut op_sel = false;
    let mut op_encode = false;
    // Parsed args, in order; only the first two tag shapes are read.
    let mut arg0: Option<TagShape> = None;
    let mut arg1: Option<TagShape> = None;
    let mut arg_count = 0usize;
    let mut args_ok = false;
    loop {
        c.ws();
        if c.eat(b'}') {
            break;
        }
        let span = match c.str_span() {
            Some(span) => span,
            None => return legacy,
        };
        // A well-formed key longer than any envelope name is simply
        // extra; malformed keys keep the legacy serde verdicts.
        let slot = match c.decode_short(span, &mut buf) {
            Short::Fit(klen) => match &buf[..klen] {
                b"v" => 0,
                b"op" => 1,
                b"args" => 2,
                _ => 99,
            },
            Short::TooLong => 99,
            Short::Bad => return legacy,
        };
        if slot == 99 || seen[slot] {
            extra_top = true;
        } else {
            seen[slot] = true;
        }
        c.ws();
        if !c.eat(b':') {
            return legacy;
        }
        c.ws();
        match slot {
            0 => {
                if !c.skip_value() {
                    return legacy;
                }
            }
            1 => {
                let vspan = match c.str_span() {
                    Some(vspan) => vspan,
                    None => {
                        if !c.skip_value() {
                            return legacy;
                        }
                        continue;
                    }
                };
                // A well-formed op name longer than any known op is
                // simply not selected; anything else leaves op_sel
                // clear and keeps the legacy verdicts.
                if let Short::Fit(vlen) = c.decode_short(vspan, &mut buf) {
                    op_sel = matches!(&buf[..vlen], b"decode-value" | b"encode-value");
                    op_encode = matches!(&buf[..vlen], b"encode-value");
                }
            }
            2 => {
                if !c.eat(b'[') {
                    return legacy;
                }
                c.ws();
                if c.eat(b']') {
                    args_ok = true;
                } else {
                    loop {
                        // Only the first two argument shapes matter; later
                        // arguments are skipped borrow-only so a huge or
                        // extra trailing argument cannot push a
                        // recognizable selected call into the serde-first
                        // path. Malformed arguments keep legacy verdicts.
                        if arg_count >= 2 {
                            if !c.skip_value() {
                                return legacy;
                            }
                            arg_count += 1;
                        } else {
                            match parse_tag(&mut c) {
                                Some(shape) => {
                                    arg_count += 1;
                                    if arg_count == 1 {
                                        arg0 = Some(shape);
                                    } else {
                                        arg1 = Some(shape);
                                    }
                                }
                                // Not tag-shaped (well-formed tags always
                                // parse): the candidate cannot be a
                                // selected call, so keep the legacy order
                                // and verdicts.
                                None => return legacy,
                            }
                        }
                        c.ws();
                        if c.eat(b',') {
                            c.ws();
                            continue;
                        }
                        if c.eat(b']') {
                            args_ok = true;
                            break;
                        }
                        return legacy;
                    }
                }
            }
            _ => {
                if !c.skip_value() {
                    return legacy;
                }
            }
        }
        c.ws();
        if c.eat(b',') {
            continue;
        }
        if c.b.get(c.p) == Some(&b'}') {
            continue;
        }
        return legacy;
    }
    c.ws();
    if c.p != c.b.len() {
        return legacy;
    }
    if !(seen[0] && seen[1] && seen[2]) || !args_ok {
        return legacy;
    }
    // Loose candidate peek: a tagged "int" scalar carrier selects the
    // strict path even with extra tag keys; anything else keeps legacy.
    let scalar = match arg0 {
        Some(ref shape)
            if shape.t_is == TagName::Str && shape.v_str.is_some_and(|span| is_int_name(c.s, c.b, span)) =>
        {
            shape
        }
        _ => return legacy,
    };
    if !op_sel {
        return legacy;
    }
    // Strict enforcement from here: every refusal is transport.
    if extra_top {
        return Preserde::Refused(transport_refused(
            "selected int request has an inexact envelope".to_string(),
        ));
    }
    if arg_count != 2 {
        return Preserde::Refused(transport_refused(format!(
            "selected int call needs 2 arguments, got {arg_count}"
        )));
    }
    if !scalar.exact {
        return Preserde::Refused(transport_refused(
            "selected int scalar tag is malformed".to_string(),
        ));
    }
    let payload = match arg1 {
        Some(ref shape) => shape,
        None => {
            return Preserde::Refused(transport_refused(
                "selected int call needs 2 arguments, got 1".to_string(),
            ));
        }
    };
    // The payload tag name decides the bound. The selected `str` and
    // `bigint` carriers enforce exact keys, then measure decoded text
    // or significant magnitude. Any other tag keeps the legacy order:
    // its subtree walks for nested bigint-decimal magnitudes (only
    // magnitudes refuse early), and everything else — including extra
    // fields on a mistyped carrier — keeps legacy verdicts byte for
    // byte (this preserves the committed `num`-tag type-violation pin).
    if !payload.exact
        && matches!(payload.t_is, TagName::Str | TagName::Bigint)
    {
        return Preserde::Refused(transport_refused(
            "selected int payload tag is malformed".to_string(),
        ));
    }
    match payload.t_is {
        TagName::Str => match payload.v_str {
            Some(span) => match c.content_ulen(span) {
                Some(len) if len <= SELECTED_INT_TEXT_MAX_BYTES => Preserde::Admitted,
                _ => Preserde::Refused(transport_refused(format!(
                    "selected int text exceeds the {} byte admission bound",
                    SELECTED_INT_TEXT_MAX_BYTES,
                ))),
            },
            None => Preserde::Refused(transport_refused(
                "selected int payload tag is malformed".to_string(),
            )),
        },
        TagName::Bigint => match payload.v_str {
            Some(span) if op_encode => match c.content_int64(span) {
                // The selected encode caller serializes an actual
                // signed64 bigint canonically (at most 20 characters),
                // so an oversized carrier or a lexically out-of-range
                // magnitude cannot come from that caller and refuses
                // before any serde allocation or bigint parse.
                // Grammar failures fast-fail in the legacy parse, and
                // in-range magnitudes keep the legacy encode order.
                IntLex::CarrierTooLong => Preserde::Refused(transport_refused(
                    "selected int value exceeds the canonical int64 carrier".to_string(),
                )),
                IntLex::OutOfRange => Preserde::Refused(transport_refused(
                    "selected int value is out of range before bigint parse".to_string(),
                )),
                IntLex::Fits | IntLex::Unparseable => Preserde::Admitted,
            },
            Some(span) => match c.content_sig(span) {
                // Significant magnitudes above int64 refuse before any
                // bigint parse; grammar failures fast-fail and small
                // magnitudes keep the legacy parse order and envelopes
                // (a 19-digit out-of-range decode stays a semantic
                // bound failure, never transport).
                Some(significant) if significant > 19 => Preserde::Refused(transport_refused(
                    "selected int value is out of range before bigint parse".to_string(),
                )),
                _ => Preserde::Admitted,
            },
            None => Preserde::Refused(transport_refused(
                "selected int value tag is malformed".to_string(),
            )),
        },
        TagName::Other => {
            let mut w = Cur {
                b: c.b,
                s: c.s,
                p: payload.span.0,
            };
            match walk_nested(&mut w, 0) {
                Walk::Huge => Preserde::Refused(transport_refused(
                    "selected int nested value is out of range before bigint parse".to_string(),
                )),
                Walk::Clean | Walk::Unparseable => Preserde::Legacy,
            }
        }
    }
}

/// Compares a raw string-token span's decoded content against `b"int"`.
fn is_int_name(s: &str, b: &[u8], span: (usize, usize)) -> bool {
    let mut pos = span.0 + 1;
    let end = span.1 - 1;
    let mut buf = [0u8; 8];
    let mut len = 0usize;
    while pos < end {
        let ch = match Cur::next_unit(s, b, &mut pos, end) {
            Some(ch) => ch,
            None => return false,
        };
        let mut tmp = [0u8; 4];
        let bytes = ch.encode_utf8(&mut tmp).as_bytes();
        if len + bytes.len() > buf.len() {
            return false;
        }
        buf[len..len + bytes.len()].copy_from_slice(bytes);
        len += bytes.len();
    }
    &buf[..len] == b"int"
}

/// Selected int/ASCII admission gate over the already-parsed (outer-cap
/// bounded) request JSON. Returns `Some(response)` exactly when the
/// request is a selected int call (`decode-value`/`encode-value` with a
/// tagged `"int"` scalar name): exact envelope/tag/scalar/arity checks
/// and the decoded-text bound refuse as transport faults BEFORE any
/// tag/serde value materialization or arbitrary-precision bigint parse.
/// Anything else returns `None` and keeps the existing legacy order
/// (decode inputs first, dispatch checks scalar/arity after) intact.
fn selected_int_gate(op: &str, req: &Json, raw_args: &[Json]) -> Option<Json> {
    if op != "decode-value" && op != "encode-value" {
        return None;
    }
    let first = match raw_args.first() {
        Some(first) => first,
        None => return None,
    };
    // Loose candidate peek borrows only: no bigint parsing here, and
    // extra tag keys never clear selection (they are refused below).
    if !selected_scalar_hint(first) {
        return None;
    }
    if !exact_keys(req, &SELECTED_ENVELOPE_KEYS) {
        return Some(transport_refused(
            "selected int request has an inexact envelope".to_string(),
        ));
    }
    if raw_args.len() != 2 {
        return Some(transport_refused(format!(
            "selected int op {op:?} needs 2 arguments, got {}",
            raw_args.len()
        )));
    }
    if selected_tag(&raw_args[0], "str").is_none() {
        return Some(transport_refused("selected int scalar tag is malformed".to_string()));
    }
    // Payload tag name decides the bound, mirroring the pre-serde scan:
    // unknown fields refuse; `str` measures decoded text and `bigint`
    // measures significant magnitude; any other well-formed tag keeps
    // the legacy semantic order (preserving the committed `num`-tag
    // type-violation pin).
    let payload = &raw_args[1];
    let tag = payload.get("t").and_then(Json::as_str).unwrap_or("");
    // Exact tag keys are enforced only on the selected carriers; any
    // other well-formed tag keeps the legacy order (nested magnitudes
    // were already walked pre-serde).
    if !exact_keys(payload, &SELECTED_TAG_KEYS) {
        if !matches!(tag, "str" | "bigint") {
            return None;
        }
        let what = if op == "decode-value" {
            "selected int payload tag is malformed"
        } else {
            "selected int value tag is malformed"
        };
        return Some(transport_refused(what.to_string()));
    }
    if op == "decode-value" {
        match tag {
            "str" => {
                let text = payload.get("v").and_then(Json::as_str).unwrap_or("");
                if text.len() > SELECTED_INT_TEXT_MAX_BYTES {
                    return Some(transport_refused(format!(
                        "selected int text exceeds the {} byte admission bound",
                        SELECTED_INT_TEXT_MAX_BYTES,
                    )));
                }
                return None;
            }
            "bigint" => {
                let text = payload.get("v").and_then(Json::as_str).unwrap_or("");
                match significant_digits(text) {
                    Some(significant) if significant.len() > 19 => {
                        return Some(transport_refused(
                            "selected int value is out of range before bigint parse".to_string(),
                        ));
                    }
                    _ => return None,
                }
            }
            _ => return None,
        }
    }
    // encode-value: the value travels as a tagged bigint decimal string.
    // The canonical carrier (at most 20 characters), the significant
    // magnitude, and the lexical 19-digit boundary refuse before any
    // arbitrary-precision parse; every other well-formed tag keeps the
    // legacy parse-then-narrow order and envelopes.
    match tag {
        "bigint" => {
            let text = payload.get("v").and_then(Json::as_str).unwrap_or("");
            match significant_digits(text) {
                None => None,
                Some(significant) => {
                    if text.len() > ENCODE_INT_CANONICAL_MAX_CHARS {
                        Some(transport_refused(
                            "selected int value exceeds the canonical int64 carrier".to_string(),
                        ))
                    } else if significant.len() > 19
                        || significant_above_int64(text, significant)
                    {
                        Some(transport_refused(
                            "selected int value is out of range before bigint parse".to_string(),
                        ))
                    } else {
                        None
                    }
                }
            }
        }
        _ => None,
    }
}

/// A transport-level error: malformed request bytes, never Can behavior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError(pub String);

impl TransportError {
    fn new(message: impl Into<String>) -> Self {
        TransportError(message.into())
    }
}

fn get_field<'a>(req: &'a Json, name: &str) -> Result<&'a Json, TransportError> {
    req.get(name)
        .ok_or_else(|| TransportError::new(format!("request is missing {name:?}")))
}

fn parse_bigint(text: &str) -> Result<BigInt, TransportError> {
    BigInt::parse_bytes(text.as_bytes(), 10)
        .ok_or_else(|| TransportError::new(format!("malformed bigint in transport: {text:?}")))
}

fn json_to_f64(v: &Json) -> Result<f64, TransportError> {
    match v {
        Json::Number(n) => n
            .as_f64()
            .ok_or_else(|| TransportError::new("non-finite JSON number in transport")),
        Json::String(s) => match s.as_str() {
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            _ => Err(TransportError::new(format!(
                "malformed num in transport: {s:?}"
            ))),
        },
        _ => Err(TransportError::new("malformed num in transport")),
    }
}

/// Decodes a tagged JSON input value to a core `Value`.
pub fn decode_input(v: &Json) -> Result<Value, TransportError> {
    let tag = v
        .get("t")
        .and_then(Json::as_str)
        .ok_or_else(|| TransportError::new("input value is missing its tag"))?;
    match tag {
        "bigint" => {
            let text = get_field(v, "v")?.as_str().ok_or_else(|| {
                TransportError::new("bigint input needs a decimal-string payload")
            })?;
            Ok(Value::BigInt(parse_bigint(text)?))
        }
        "num" => Ok(Value::Num(json_to_f64(get_field(v, "v")?)?)),
        "str" => {
            let text = get_field(v, "v")?
                .as_str()
                .ok_or_else(|| TransportError::new("str input needs a string payload"))?;
            Ok(Value::Str(text.to_string()))
        }
        "bool" => {
            let flag = get_field(v, "v")?
                .as_bool()
                .ok_or_else(|| TransportError::new("bool input needs a boolean payload"))?;
            Ok(Value::Bool(flag))
        }
        "null" => Ok(Value::Null),
        "undef" => Ok(Value::Undefined),
        "decimal" => {
            let coef = get_field(v, "coef")?
                .as_str()
                .ok_or_else(|| TransportError::new("decimal input needs a coef payload"))?;
            let scale = json_to_f64(get_field(v, "scale")?)?;
            Ok(Value::Record(vec![
                ("kind".to_string(), Value::Str("decimal".to_string())),
                ("coef".to_string(), Value::BigInt(parse_bigint(coef)?)),
                ("scale".to_string(), Value::Num(scale)),
            ]))
        }
        "money" => {
            let minor = get_field(v, "minor")?
                .as_str()
                .ok_or_else(|| TransportError::new("money input needs a minor payload"))?;
            let currency = get_field(v, "currency")?
                .as_str()
                .ok_or_else(|| TransportError::new("money input needs a currency payload"))?;
            Ok(Value::Record(vec![
                ("kind".to_string(), Value::Str("money".to_string())),
                ("minor".to_string(), Value::BigInt(parse_bigint(minor)?)),
                ("currency".to_string(), Value::Str(currency.to_string())),
            ]))
        }
        "date" => {
            let year = json_to_f64(get_field(v, "year")?)?;
            let month = json_to_f64(get_field(v, "month")?)?;
            let day = json_to_f64(get_field(v, "day")?)?;
            Ok(Value::Record(vec![
                ("kind".to_string(), Value::Str("date".to_string())),
                ("year".to_string(), Value::Num(year)),
                ("month".to_string(), Value::Num(month)),
                ("day".to_string(), Value::Num(day)),
            ]))
        }
        "datetime" => {
            let ms = get_field(v, "ms")?
                .as_str()
                .ok_or_else(|| TransportError::new("datetime input needs an ms payload"))?;
            Ok(Value::Record(vec![
                ("kind".to_string(), Value::Str("datetime".to_string())),
                ("ms".to_string(), Value::BigInt(parse_bigint(ms)?)),
            ]))
        }
        "array" => {
            let items = get_field(v, "items")?
                .as_array()
                .ok_or_else(|| TransportError::new("array input needs an items payload"))?;
            Ok(Value::Array(
                items.iter().map(decode_input).collect::<Result<_, _>>()?,
            ))
        }
        "record" => {
            let entries = get_field(v, "entries")?
                .as_array()
                .ok_or_else(|| TransportError::new("record input needs an entries payload"))?;
            let mut out = Vec::with_capacity(entries.len());
            let mut keys = HashSet::with_capacity(entries.len());
            for entry in entries {
                let pair = entry.as_array().ok_or_else(|| {
                    TransportError::new("record entries must be [key, value] pairs")
                })?;
                if pair.len() != 2 {
                    return Err(TransportError::new(
                        "record entries must be [key, value] pairs",
                    ));
                }
                let key = pair[0]
                    .as_str()
                    .ok_or_else(|| TransportError::new("record keys must be strings"))?;
                if !keys.insert(key) {
                    return Err(TransportError::new("record keys must not repeat"));
                }
                out.push((key.to_string(), decode_input(&pair[1])?));
            }
            Ok(Value::Record(out))
        }
        "other" => {
            let tag = get_field(v, "tag")?
                .as_str()
                .ok_or_else(|| TransportError::new("other input needs a tag payload"))?;
            Ok(Value::Other(tag.to_string()))
        }
        _ => Err(TransportError::new(format!(
            "unknown input tag in transport: {tag:?}"
        ))),
    }
}

/// Encodes a core output `Value` to tagged JSON.
pub fn encode_output(value: &Value) -> Json {
    match value {
        Value::BigInt(int) => serde_json::json!({"t": "bigint", "v": int.to_string()}),
        Value::Num(number) => {
            if number.is_nan() {
                serde_json::json!({"t": "num", "v": "NaN"})
            } else if number.is_infinite() {
                serde_json::json!({"t": "num", "v": if *number > 0.0 { "Infinity" } else { "-Infinity" }})
            } else {
                serde_json::json!({"t": "num", "v": number})
            }
        }
        Value::Str(text) => serde_json::json!({"t": "str", "v": text}),
        Value::Bool(flag) => serde_json::json!({"t": "bool", "v": flag}),
        Value::Null => serde_json::json!({"t": "null"}),
        Value::Undefined => serde_json::json!({"t": "undef"}),
        Value::Decimal(parts) => serde_json::json!({
            "t": "decimal", "coef": parts.coef.to_string(), "scale": parts.scale,
        }),
        Value::Money(parts) => serde_json::json!({
            "t": "money", "minor": parts.minor.to_string(), "currency": parts.currency,
        }),
        Value::Date(parts) => serde_json::json!({
            "t": "date", "year": parts.year, "month": parts.month, "day": parts.day,
        }),
        Value::Datetime(parts) => serde_json::json!({
            "t": "datetime", "ms": parts.ms.to_string(),
        }),
        Value::Array(items) => serde_json::json!({
            "t": "array", "items": items.iter().map(encode_output).collect::<Vec<_>>(),
        }),
        Value::Record(entries) => serde_json::json!({
            "t": "record",
            "entries": entries.iter().map(|(k, v)| (k, encode_output(v))).collect::<Vec<_>>(),
        }),
        Value::Other(tag) => serde_json::json!({"t": "other", "tag": tag}),
    }
}

fn encode_wire(wire: &WireValue) -> Json {
    match wire {
        WireValue::Text(text) => serde_json::json!({"t": "str", "v": text}),
        WireValue::Object(entries) => serde_json::json!({
            "t": "record",
            "entries": entries.iter().map(|(k, v)| (k, encode_wire(v))).collect::<Vec<_>>(),
        }),
    }
}

fn ok(value: Value) -> Json {
    serde_json::json!({"ok": true, "value": encode_output(&value)})
}

fn ok_wire(wire: &WireValue) -> Json {
    serde_json::json!({"ok": true, "value": encode_wire(wire)})
}

fn err(failure: &Failure) -> Json {
    serde_json::json!({
        "ok": false,
        "code": failure.code.as_str(),
        "message": failure.message,
    })
}

fn int_result(result: Result<i64, Failure>) -> Json {
    match result {
        Ok(v) => ok(Value::BigInt(BigInt::from(v))),
        Err(f) => err(&f),
    }
}

fn cmp_result(result: Result<i8, Failure>) -> Json {
    match result {
        Ok(v) => ok(Value::Num(v as f64)),
        Err(f) => err(&f),
    }
}

fn bool_result(result: Result<bool, Failure>) -> Json {
    match result {
        Ok(v) => ok(Value::Bool(v)),
        Err(f) => err(&f),
    }
}

fn expect_args<'a>(
    args: &'a [Value],
    op: &str,
    arity: usize,
) -> Result<&'a [Value], TransportError> {
    if args.len() != arity {
        return Err(TransportError::new(format!(
            "op {op:?} needs {arity} argument(s), got {}",
            args.len()
        )));
    }
    Ok(args)
}

/// Dispatches one decoded operation to the native core.
pub fn dispatch(op: &str, args: &[Value]) -> Result<Json, TransportError> {
    use crate::aggregates;
    use crate::numeric;
    use crate::temporal;

    match op {
        // -- integers -------------------------------------------------------
        "int64" => {
            let args = expect_args(args, op, 1)?;
            Ok(int_result(numeric::integer::int64(&args[0])))
        }
        "add-int" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(numeric::integer::add_int(&args[0], &args[1])))
        }
        "subtract-int" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(numeric::integer::subtract_int(
                &args[0], &args[1],
            )))
        }
        "multiply-int" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(numeric::integer::multiply_int(
                &args[0], &args[1],
            )))
        }
        "mod-int" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(numeric::integer::mod_int(&args[0], &args[1])))
        }
        "negate-int" => {
            let args = expect_args(args, op, 1)?;
            Ok(int_result(numeric::integer::negate_int(&args[0])))
        }
        "abs-int" => {
            let args = expect_args(args, op, 1)?;
            Ok(int_result(numeric::integer::abs_int(&args[0])))
        }
        "compare-int" => {
            let args = expect_args(args, op, 2)?;
            Ok(cmp_result(numeric::integer::compare_int(
                &args[0], &args[1],
            )))
        }
        // -- rounding -------------------------------------------------------
        "round-rational" => {
            let args = expect_args(args, op, 2)?;
            match numeric::rounding::round_rational_half_even(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::BigInt(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        // -- decimals -------------------------------------------------------
        "add-decimal" => {
            let args = expect_args(args, op, 2)?;
            match numeric::decimal::add_decimal(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "subtract-decimal" => {
            let args = expect_args(args, op, 2)?;
            match numeric::decimal::subtract_decimal(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "multiply-decimal" => {
            let args = expect_args(args, op, 2)?;
            match numeric::decimal::multiply_decimal(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "divide-decimal" => {
            let args = expect_args(args, op, 2)?;
            match numeric::decimal::divide_decimal(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "divide-duration-ms" => {
            let args = expect_args(args, op, 2)?;
            match numeric::decimal::divide_duration_ms(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "negate-decimal" => {
            let args = expect_args(args, op, 1)?;
            match numeric::decimal::negate_decimal(&args[0]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "abs-decimal" => {
            let args = expect_args(args, op, 1)?;
            match numeric::decimal::abs_decimal(&args[0]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "round-decimal" => {
            let args = expect_args(args, op, 2)?;
            match numeric::decimal::round_decimal(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "compare-decimal" => {
            let args = expect_args(args, op, 2)?;
            Ok(cmp_result(numeric::decimal::compare_decimal(
                &args[0], &args[1],
            )))
        }
        "equal-decimal" => {
            let args = expect_args(args, op, 2)?;
            Ok(bool_result(numeric::decimal::equal_decimal(
                &args[0], &args[1],
            )))
        }
        "parse-decimal" => {
            let args = expect_args(args, op, 1)?;
            match numeric::decimal::parse_decimal(&args[0]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "decimal-from-integer" => {
            let args = expect_args(args, op, 1)?;
            match numeric::decimal::decimal_from_integer(&args[0]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "decimal-to-string" => {
            let args = expect_args(args, op, 1)?;
            match numeric::decimal::decimal_to_string(&args[0]) {
                Ok(v) => Ok(ok(Value::Str(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        // -- money ----------------------------------------------------------
        "currency-scale" => {
            let args = expect_args(args, op, 1)?;
            match numeric::money::currency_scale(&args[0]) {
                Ok(v) => Ok(ok(Value::Num(v as f64))),
                Err(f) => Ok(err(&f)),
            }
        }
        "is-known-currency" => {
            let args = expect_args(args, op, 1)?;
            Ok(ok(Value::Bool(numeric::money::is_known_currency(&args[0]))))
        }
        "money" => {
            let args = expect_args(args, op, 2)?;
            match numeric::money::make_money_value(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "make-money" => {
            let args = expect_args(args, op, 2)?;
            match numeric::money::make_money_structural(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "add-money" => {
            let args = expect_args(args, op, 2)?;
            match numeric::money::add_money(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "subtract-money" => {
            let args = expect_args(args, op, 2)?;
            match numeric::money::subtract_money(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "multiply-money" => {
            let args = expect_args(args, op, 2)?;
            match numeric::money::multiply_money(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "divide-money" => {
            let args = expect_args(args, op, 2)?;
            match numeric::money::divide_money(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "money-ratio" => {
            let args = expect_args(args, op, 2)?;
            match numeric::money::money_ratio(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Decimal(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "compare-money" => {
            let args = expect_args(args, op, 2)?;
            Ok(cmp_result(numeric::money::compare_money(
                &args[0], &args[1],
            )))
        }
        "equal-money" => {
            let args = expect_args(args, op, 2)?;
            Ok(bool_result(numeric::money::equal_money(&args[0], &args[1])))
        }
        "negate-money" => {
            let args = expect_args(args, op, 1)?;
            match numeric::money::negate_money(&args[0]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "abs-money" => {
            let args = expect_args(args, op, 1)?;
            match numeric::money::abs_money(&args[0]) {
                Ok(v) => Ok(ok(Value::Money(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        // -- temporal -------------------------------------------------------
        "date-to-epoch-days" => {
            let args = expect_args(args, op, 1)?;
            match temporal::civil::date_to_epoch_days(&args[0]) {
                // TS returns a JS number here, not a bigint.
                Ok(v) => Ok(ok(Value::Num(v as f64))),
                Err(f) => Ok(err(&f)),
            }
        }
        "epoch-days-to-date" => {
            let args = expect_args(args, op, 1)?;
            match temporal::civil::epoch_days_to_date(&args[0]) {
                Ok(v) => Ok(ok(Value::Date(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "parse-date" => {
            let args = expect_args(args, op, 1)?;
            match temporal::civil::parse_date(&args[0]) {
                Ok(v) => Ok(ok(Value::Date(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "parse-datetime" => {
            let args = expect_args(args, op, 1)?;
            match temporal::instant::parse_datetime(&args[0]) {
                Ok(v) => Ok(ok(Value::Datetime(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "make-date" => {
            let args = expect_args(args, op, 3)?;
            let parts = (0..3)
                .map(|i| match &args[i] {
                    Value::Num(n) => Ok(*n),
                    _ => Err(()),
                })
                .collect::<Result<Vec<_>, _>>();
            match parts {
                Ok(p) => match crate::representations::numeric::make_date(p[0], p[1], p[2]) {
                    Ok(v) => Ok(ok(Value::Date(v))),
                    Err(f) => Ok(err(&f)),
                },
                // Mirrors the per-part `Number.isInteger` loop: the first
                // non-integer part fails with its label.
                Err(()) => {
                    let labels = ["year", "month", "day"];
                    for (i, label) in labels.iter().enumerate() {
                        match &args[i] {
                            Value::Num(n)
                                if crate::representations::numeric::is_integer_number(*n) => {}
                            _ => {
                                return Ok(err(&Failure::invalid_construction(format!(
                                    "date {label} must be an integer"
                                ))));
                            }
                        }
                    }
                    Err(TransportError::new("unreachable make-date guard"))
                }
            }
        }
        "make-datetime" => {
            let args = expect_args(args, op, 1)?;
            match &args[0] {
                Value::BigInt(ms) => {
                    match crate::representations::numeric::make_datetime(ms.clone()) {
                        Ok(v) => Ok(ok(Value::Datetime(v))),
                        Err(f) => Ok(err(&f)),
                    }
                }
                _ => Ok(err(&Failure::invalid_construction(
                    "datetime ms must be a bigint",
                ))),
            }
        }
        "add-days" => {
            let args = expect_args(args, op, 2)?;
            match temporal::civil::add_days(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Date(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "add-months" => {
            let args = expect_args(args, op, 2)?;
            match temporal::civil::add_months(&args[0], &args[1]) {
                Ok(v) => Ok(ok(Value::Date(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "date-year" => {
            let args = expect_args(args, op, 1)?;
            match temporal::civil::date_year(&args[0]) {
                Ok(v) => Ok(ok(Value::BigInt(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "weekday" => {
            let args = expect_args(args, op, 1)?;
            match temporal::civil::weekday(&args[0]) {
                Ok(v) => Ok(ok(Value::BigInt(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "dates" => {
            let args = expect_args(args, op, 3)?;
            match temporal::civil::dates(&args[0], &args[1], &args[2]) {
                Ok(v) => Ok(ok(Value::Array(v.into_iter().map(Value::Date).collect()))),
                Err(f) => Ok(err(&f)),
            }
        }
        "overlaps" => {
            let args = expect_args(args, op, 4)?;
            Ok(bool_result(temporal::instant::overlaps(
                &args[0], &args[1], &args[2], &args[3],
            )))
        }
        "add-duration" => {
            let args = expect_args(args, op, 2)?;
            match temporal::duration::add_duration(&args[0], &args[1]) {
                Ok(temporal::duration::DurationSum::Duration(v)) => {
                    Ok(ok(Value::BigInt(BigInt::from(v))))
                }
                Ok(temporal::duration::DurationSum::Datetime(v)) => Ok(ok(Value::Datetime(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "subtract-duration" => {
            let args = expect_args(args, op, 2)?;
            match temporal::duration::subtract_duration(&args[0], &args[1]) {
                Ok(temporal::duration::DurationSum::Duration(v)) => {
                    Ok(ok(Value::BigInt(BigInt::from(v))))
                }
                Ok(temporal::duration::DurationSum::Datetime(v)) => Ok(ok(Value::Datetime(v))),
                Err(f) => Ok(err(&f)),
            }
        }
        "multiply-duration" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(temporal::duration::multiply_duration(
                &args[0], &args[1],
            )))
        }
        "divide-duration-by-int" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(temporal::duration::divide_duration_by_int(
                &args[0], &args[1],
            )))
        }
        "remainder-duration" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(temporal::duration::remainder_duration(
                &args[0], &args[1],
            )))
        }
        "compare-duration" => {
            let args = expect_args(args, op, 2)?;
            Ok(cmp_result(temporal::duration::compare_duration(
                &args[0], &args[1],
            )))
        }
        "negate-duration" => {
            let args = expect_args(args, op, 1)?;
            Ok(int_result(temporal::duration::negate_duration(&args[0])))
        }
        "abs-duration" => {
            let args = expect_args(args, op, 1)?;
            Ok(int_result(temporal::duration::abs_duration(&args[0])))
        }
        "duration-between" => {
            let args = expect_args(args, op, 2)?;
            Ok(int_result(temporal::instant::duration_between(
                &args[0], &args[1],
            )))
        }
        "compare-instant" => {
            let args = expect_args(args, op, 2)?;
            Ok(cmp_result(temporal::instant::compare_instant(
                &args[0], &args[1],
            )))
        }
        "compare-date" => {
            let args = expect_args(args, op, 2)?;
            Ok(cmp_result(temporal::civil::compare_date(
                &args[0], &args[1],
            )))
        }
        // -- aggregates -----------------------------------------------------
        "sum-int" => {
            let args = expect_args(args, op, 1)?;
            let domain = aggregates::numeric::require_domain(&args[0], "sumInt");
            match domain {
                Ok(items) => Ok(int_result(aggregates::integer::sum_int(items))),
                Err(f) => Ok(err(&f)),
            }
        }
        "sum-decimal" => {
            let args = expect_args(args, op, 1)?;
            let domain = aggregates::numeric::require_domain(&args[0], "sumDecimal");
            match domain {
                Ok(items) => match aggregates::decimal::sum_decimal(items) {
                    Ok(v) => Ok(ok(Value::Decimal(v))),
                    Err(f) => Ok(err(&f)),
                },
                Err(f) => Ok(err(&f)),
            }
        }
        "sum-duration" => {
            let args = expect_args(args, op, 1)?;
            let domain = aggregates::numeric::require_domain(&args[0], "sumDuration");
            match domain {
                Ok(items) => Ok(int_result(aggregates::integer::sum_duration(items))),
                Err(f) => Ok(err(&f)),
            }
        }
        "sum-money" => {
            if args.len() != 1 && args.len() != 2 {
                return Err(TransportError::new(format!(
                    "op {op:?} needs 1 or 2 argument(s), got {}",
                    args.len()
                )));
            }
            let domain = aggregates::numeric::require_domain(&args[0], "sumMoney");
            match domain {
                Ok(items) => {
                    let currency = args.get(1);
                    match aggregates::money::sum_money(items, currency) {
                        Ok(v) => Ok(ok(Value::Money(v))),
                        Err(f) => Ok(err(&f)),
                    }
                }
                Err(f) => Ok(err(&f)),
            }
        }
        // -- codecs ---------------------------------------------------------
        "decode-value" => {
            let args = expect_args(args, op, 2)?;
            let name = match &args[0] {
                Value::Str(name) => name,
                _ => {
                    return Err(TransportError::new(
                        "decode-value needs a scalar-name string",
                    ));
                }
            };
            let scalar = ScalarName::parse(name).ok_or_else(|| {
                TransportError::new(format!("decode-value has no scalar {name:?}"))
            })?;
            match decode_value_scalar(scalar, &args[1]) {
                Ok(value) => Ok(ok(value)),
                Err(violations) => Ok(serde_json::json!({
                    "ok": false,
                    "violations": violations.iter().map(|v| {
                        let mut item = serde_json::json!({
                            "path": v.path.iter().map(|seg| match seg {
                                crate::codecs::numeric::PathSeg::Key(k) => {
                                    serde_json::json!(k)
                                }
                                crate::codecs::numeric::PathSeg::Index(i) => {
                                    serde_json::json!(i)
                                }
                            }).collect::<Vec<_>>(),
                            "code": v.code.as_str(),
                            "message": v.message,
                        });
                        if let Some(expected) = &v.expected {
                            item["expected"] = serde_json::json!(expected);
                        }
                        if let Some(actual) = &v.actual {
                            item["actual"] = serde_json::json!(actual);
                        }
                        item
                    }).collect::<Vec<_>>(),
                })),
            }
        }
        "encode-value" => {
            let args = expect_args(args, op, 2)?;
            let name = match &args[0] {
                Value::Str(name) => name,
                _ => {
                    return Err(TransportError::new(
                        "encode-value needs a scalar-name string",
                    ));
                }
            };
            let scalar = ScalarName::parse(name).ok_or_else(|| {
                TransportError::new(format!("encode-value has no scalar {name:?}"))
            })?;
            match encode_value_scalar(scalar, &args[1]) {
                Ok(wire) => Ok(ok_wire(&wire)),
                Err(f) => Ok(err(&f)),
            }
        }
        // -- guards ---------------------------------------------------------
        "is-decimal" => {
            let args = expect_args(args, op, 1)?;
            Ok(ok(Value::Bool(is_decimal_value(&args[0]))))
        }
        "is-money" => {
            let args = expect_args(args, op, 1)?;
            Ok(ok(Value::Bool(is_money_value(&args[0]))))
        }
        "is-date" => {
            let args = expect_args(args, op, 1)?;
            Ok(ok(Value::Bool(is_date_value(&args[0]))))
        }
        "is-datetime" => {
            let args = expect_args(args, op, 1)?;
            Ok(ok(Value::Bool(is_datetime_value(&args[0]))))
        }
        "is-currency-shape" => {
            let args = expect_args(args, op, 1)?;
            match &args[0] {
                Value::Str(code) => Ok(ok(Value::Bool(is_currency_shape(code)))),
                // Non-strings are false here; the only divergence from the
                // RegExp.test coercion is single-element 3-letter arrays
                // (plus symbol TypeErrors), which vectors never generate
                // (parity ledger).
                _ => Ok(ok(Value::Bool(false))),
            }
        }
        _ => Err(TransportError::new(format!(
            "unknown op in transport: {op:?}"
        ))),
    }
}

/// Handles one raw request line, returning the response JSON.
///
/// Selected admission runs before any JSON/tag/serde allocation: the
/// borrow-only pre-serde scan recognizes selected int calls
/// (`decode-value`/`encode-value` with the tagged `"int"` scalar) and
/// refuses inexact envelopes/tags, wrong arity, over-bound decoded text,
/// oversized carriers, and out-of-range bigint magnitudes as transport
/// faults before any tagged value materialization or bigint parse. The
/// derived raw-bytes bound applies only to scan-admitted selected calls
/// (a padded-but-admitted envelope cannot smuggle allocation past the
/// decoded-text measure). All other calls keep the exact pre-admission
/// legacy order: envelope/tag/scalar/arity checks in dispatch stay
/// strict but run after inputs decode, at every size serde accepts.
pub fn handle_line(line: &str) -> Json {
    match preserde_selected_scan(line) {
        Preserde::Refused(refused) => return refused,
        Preserde::Admitted if line.len() > SELECTED_REQUEST_MAX_BYTES => {
            return serde_json::json!({"ok": false, "transport": format!(
                "selected int request exceeds the admission bound of {} bytes",
                SELECTED_REQUEST_MAX_BYTES,
            )});
        }
        Preserde::Admitted | Preserde::Legacy => {}
    }
    let parsed: Result<Json, _> = serde_json::from_str(line);
    let req = match parsed {
        Ok(req) => req,
        Err(error) => {
            return serde_json::json!({"ok": false, "transport": format!("invalid JSON: {error}")});
        }
    };
    let version = req.get("v").and_then(Json::as_u64).unwrap_or(0);
    if version != ABI_VERSION as u64 {
        return serde_json::json!({
            "ok": false,
            "transport": format!("unsupported ABI version {version}, want {}", ABI_VERSION),
        });
    }
    let op = match req.get("op").and_then(Json::as_str) {
        Some(op) => op,
        None => {
            return serde_json::json!({"ok": false, "transport": "request is missing its op"});
        }
    };
    let raw_args = match req.get("args").and_then(Json::as_array) {
        Some(args) => args,
        None => {
            return serde_json::json!({"ok": false, "transport": "request is missing its args"});
        }
    };
    // Selected int calls refuse inexact envelopes/tags/arity and
    // over-bound text or out-of-range magnitudes here, before any
    // tagged value is materialized or any bigint is parsed. All other
    // calls keep the existing decode-first order below.
    if let Some(refused) = selected_int_gate(op, &req, raw_args) {
        return refused;
    }
    let mut args = Vec::with_capacity(raw_args.len());
    for raw in raw_args {
        match decode_input(raw) {
            Ok(value) => args.push(value),
            Err(error) => {
                return serde_json::json!({"ok": false, "transport": error.0});
            }
        }
    }
    match dispatch(op, &args) {
        Ok(response) => response,
        Err(error) => serde_json::json!({"ok": false, "transport": error.0}),
    }
}
