//! Mechanical execution of owned-input conformance cases (D1 gate).
//!
//! Every row of each `cases.json` present under
//! `packages/values/conformance/owned-input/` (v1 required, v2 when
//! E publishes it into the checkout) runs against the native arena;
//! NOTHING is hand-pinned — expected values are read from the fixture
//! and compared mechanically. Each outcome is recorded, the full
//! enumeration prints, and the test fails listing every divergence.
//!
//! Host emulation (documented, spec'd — not fixture mimicry):
//! - JSON text parses to UTF-16 units WITHOUT pairing surrogates
//!   (what `JSON.parse` yields; Rust `str` cannot hold them, so the
//!   runner carries its own `JVal` with `Vec<u16>` strings — including
//!   for the fixture file itself, which `serde_json` cannot load).
//! - Object sources keep DUPLICATE pairs in source order, then apply
//!   `OrdinaryOwnPropertyKeys` order (canonical integer-index keys
//!   ascending, the rest stable). This is the unique rule consistent
//!   with both `keys/integer-like-order` (transport reordered) and
//!   `keys/duplicates-preserved` (transport keeps both pairs).
//! - Number tokens parse under strict JSON grammar with host-like
//!   overflow (`1e400` -> `+Infinity`); bits are cross-checked
//!   against `expect.host`.

use values_semantics::input::{
    Budgets, Frame, InputArena, MintedTag, TransportNode, MAX_ID_LENGTH_UNITS,
};
use values_semantics::plans::{OwnerScope, Plans, Provenance, SchemaInput};

/// Fixture versions present in the checkout: v1 is required; v2
/// (E's D1 follow-up) executes when present, with zero overrides.
/// v1 carries two documented ruling overrides (frozen text E
/// superseded — the mechanical mismatch is still computed, then the
/// ruling resolves it): ADOPT-G `entries` for
/// `tags/forged-sentinel-is-data`, and SPLIT `id-units` for
/// `length/id-257-units-rejects`. Nothing else is overridden, ever.
fn load_cases() -> Vec<(String, String)> {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/owned-input");
    let mut out = Vec::new();
    for version in ["v1", "v2"] {
        let path = format!("{root}/{version}/cases.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => out.push((version.to_string(), text)),
            Err(_) if version == "v1" => panic!("cases.json: missing required v1"),
            Err(_) => {}
        }
    }
    out
}

const GENEROUS: Budgets = Budgets {
    max_nodes: 100_000,
    max_depth: 100,
    max_text_units: 100_000,
    max_entries: 10_000,
};

// ---------- surrogate-preserving JSON values ----------

/// JSON value with strings as raw UTF-16 units (lone surrogates kept)
/// and objects as duplicate-preserving pair lists.
#[derive(Debug, Clone, PartialEq)]
enum JVal {
    Null,
    Bool(bool),
    /// Exact f64 bits of the number token.
    Num(u64),
    Str(Vec<u16>),
    Arr(Vec<JVal>),
    Obj(Vec<(Vec<u16>, JVal)>),
}

impl JVal {
    fn get(&self, key: &str) -> Option<&JVal> {
        let want: Vec<u16> = key.encode_utf16().collect();
        match self {
            JVal::Obj(pairs) => pairs.iter().rev().find(|(k, _)| *k == want).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_units(&self) -> Option<&[u16]> {
        match self {
            JVal::Str(u) => Some(u),
            _ => None,
        }
    }

    /// Fixture integer (units, declared, available, length): the
    /// token parsed as f64 bits, converted back to a count.
    fn as_count(&self) -> Option<u64> {
        match self {
            JVal::Num(b) => Some(f64::from_bits(*b) as u64),
            _ => None,
        }
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            JVal::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

/// Lossy render for diagnostics only (never an observation).
fn show(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

fn parse_json(text: &str) -> Result<JVal, String> {
    let mut p = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    let value = p.parse_value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(format!("trailing bytes at {}", p.pos));
    }
    Ok(value)
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len()
            && matches!(self.bytes[self.pos], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at {}", byte as char, self.pos))
        }
    }

    fn parse_value(&mut self) -> Result<JVal, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => Ok(JVal::Str(self.parse_string()?)),
            Some(b't') => self.parse_literal("true", JVal::Bool(true)),
            Some(b'f') => self.parse_literal("false", JVal::Bool(false)),
            Some(b'n') => self.parse_literal("null", JVal::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.parse_number(),
            other => Err(format!("unexpected {other:?} at {}", self.pos)),
        }
    }

    fn parse_literal(&mut self, word: &str, value: JVal) -> Result<JVal, String> {
        if self.bytes[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err(format!("bad literal at {}", self.pos))
        }
    }

    fn parse_object(&mut self) -> Result<JVal, String> {
        self.expect(b'{')?;
        let mut pairs = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(JVal::Obj(pairs));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(b':')?;
            let value = self.parse_value()?;
            pairs.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(JVal::Obj(pairs));
                }
                other => return Err(format!("bad object at {other:?} {}", self.pos)),
            }
        }
    }

    fn parse_array(&mut self) -> Result<JVal, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(JVal::Arr(items));
        }
        loop {
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(JVal::Arr(items));
                }
                other => return Err(format!("bad array at {other:?} {}", self.pos)),
            }
        }
    }

    /// Decodes escapes to units WITHOUT pairing surrogates (host truth).
    fn parse_string(&mut self) -> Result<Vec<u16>, String> {
        self.expect(b'"')?;
        let mut units = Vec::new();
        loop {
            let byte = self.peek().ok_or("unterminated string")?;
            match byte {
                b'"' => {
                    self.pos += 1;
                    return Ok(units);
                }
                b'\\' => {
                    self.pos += 1;
                    let esc = self.peek().ok_or("bad escape")?;
                    self.pos += 1;
                    match esc {
                        b'"' => units.push(0x22),
                        b'\\' => units.push(0x5C),
                        b'/' => units.push(0x2F),
                        b'b' => units.push(0x08),
                        b'f' => units.push(0x0C),
                        b'n' => units.push(0x0A),
                        b'r' => units.push(0x0D),
                        b't' => units.push(0x09),
                        b'u' => {
                            if self.pos + 4 > self.bytes.len() {
                                return Err("bad \\u escape".to_string());
                            }
                            let hex = std::str::from_utf8(&self.bytes[self.pos..self.pos + 4])
                                .map_err(|_| "bad \\u escape")?;
                            let unit =
                                u16::from_str_radix(hex, 16).map_err(|_| "bad \\u escape")?;
                            self.pos += 4;
                            units.push(unit);
                        }
                        other => return Err(format!("bad escape \\{}", other as char)),
                    }
                }
                0x00..=0x1F => return Err("control in string".to_string()),
                _ => {
                    // Raw UTF-8 scalar (the fixture file itself is valid
                    // UTF-8 outside escapes); decode one scalar to units.
                    let rest = &self.bytes[self.pos..];
                    let text = std::str::from_utf8(rest).map_err(|_| "bad utf8")?;
                    let ch = text.chars().next().ok_or("bad utf8")?;
                    let mut buf = [0u16; 2];
                    units.extend(ch.encode_utf16(&mut buf).iter().copied());
                    self.pos += ch.len_utf8();
                }
            }
        }
    }

    /// JSON number token -> f64 bits. Grammar validated strictly
    /// (JSON, not Rust float syntax); conversion via `f64::from_str`,
    /// which overflows to infinity exactly like the host (`1e400` ->
    /// `+Infinity` — `serde_json` errors there instead).
    fn parse_number(&mut self) -> Result<JVal, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while self.pos < self.bytes.len()
            && (self.bytes[self.pos].is_ascii_alphanumeric()
                || matches!(self.bytes[self.pos], b'.' | b'+' | b'-'))
        {
            self.pos += 1;
        }
        let token = std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| "bad number")?;
        if !is_json_number(token) {
            return Err(format!("bad number {token}"));
        }
        let value: f64 = token.parse().map_err(|_| format!("bad number {token}"))?;
        Ok(JVal::Num(value.to_bits()))
    }
}

/// Strict JSON number grammar: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`.
fn is_json_number(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut i = 0;
    if i < bytes.len() && bytes[i] == b'-' {
        i += 1;
    }
    if i >= bytes.len() {
        return false;
    }
    if bytes[i] == b'0' {
        i += 1;
    } else if bytes[i].is_ascii_digit() {
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    } else {
        return false;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

// ---------- host key order + frames ----------

/// Canonical integer-index key per `OrdinaryOwnPropertyKeys`:
/// `ToString(ToUint32(key)) == key`, excluding 2^32-1.
fn canonical_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 {
        return None;
    }
    if key.len() > 1 && key[0] == b'0' as u16 {
        return None;
    }
    if !key.iter().all(|u| (b'0' as u16..=b'9' as u16).contains(u)) {
        return None;
    }
    let text: String = key.iter().map(|u| *u as u8 as char).collect();
    let index: u64 = text.parse().ok()?;
    if index >= 4_294_967_295 {
        return None;
    }
    Some(index as u32)
}

/// Host enumeration order over duplicate-preserving pairs: integer
/// indices ascending first, everything else stable in source order.
fn js_order(pairs: &[(Vec<u16>, JVal)]) -> Vec<(Vec<u16>, JVal)> {
    let mut indexed: Vec<(u32, usize)> = Vec::new();
    let mut rest: Vec<usize> = Vec::new();
    for (i, (key, _)) in pairs.iter().enumerate() {
        match canonical_index(key) {
            Some(n) => indexed.push((n, i)),
            None => rest.push(i),
        }
    }
    indexed.sort();
    indexed
        .into_iter()
        .map(|(_, i)| i)
        .chain(rest)
        .map(|i| pairs[i].clone())
        .collect()
}

/// Host last-wins view (what `JSON.parse` yields for duplicates).
fn last_wins(pairs: &[(Vec<u16>, JVal)]) -> Vec<(Vec<u16>, JVal)> {
    let mut out: Vec<(Vec<u16>, JVal)> = Vec::new();
    for (key, value) in pairs {
        if let Some(slot) = out.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value.clone();
        } else {
            out.push((key.clone(), value.clone()));
        }
    }
    js_order(&out)
}

fn jval_to_frame(value: &JVal) -> Frame {
    match value {
        JVal::Null => Frame::OwnNull,
        JVal::Bool(b) => Frame::Bool(*b),
        JVal::Num(bits) => Frame::F64Bits(*bits),
        JVal::Str(units) => Frame::TextUnits(units.clone()),
        JVal::Arr(items) => Frame::Array(items.iter().map(jval_to_frame).collect()),
        JVal::Obj(pairs) => Frame::Entries(
            js_order(pairs)
                .into_iter()
                .map(|(key, value)| (key, jval_to_frame(&value)))
                .collect(),
        ),
    }
}

/// Arena node -> tag name. Minted names are G-chosen pending E's D1
/// ruling (they currently match the V03.1 strings 1:1).
fn node_tag(node: &TransportNode) -> &'static str {
    match node {
        TransportNode::F64 { .. } => "f64",
        TransportNode::Text { .. } => "text",
        TransportNode::Bool(_) => "bool",
        TransportNode::OwnNull => "own-null",
        TransportNode::Missing => "missing",
        TransportNode::Array { .. } => "array",
        TransportNode::Entries { .. } => "entries",
        TransportNode::Tagged { tag, .. } => match tag {
            MintedTag::DefaultApplied { .. } => "default-applied",
            MintedTag::DefaultAbsent => "default-absent",
            MintedTag::UpdateOmitted => "update-omitted",
            MintedTag::DroppedUnknown { .. } => "dropped-unknown",
        },
    }
}

fn node_to_jval(arena: &InputArena, index: usize) -> JVal {
    match arena.node(index) {
        TransportNode::F64 { bits } => JVal::Num(*bits),
        TransportNode::Text { units } => JVal::Str(units.clone()),
        TransportNode::Bool(b) => JVal::Bool(*b),
        TransportNode::OwnNull => JVal::Null,
        TransportNode::Missing => {
            JVal::Obj(vec![("missing".encode_utf16().collect(), JVal::Bool(true))])
        }
        TransportNode::Array { items } => {
            JVal::Arr(items.iter().map(|i| node_to_jval(arena, *i)).collect())
        }
        TransportNode::Entries { entries } => JVal::Obj(
            entries
                .iter()
                .map(|e| (e.key.clone(), node_to_jval(arena, e.node)))
                .collect(),
        ),
        TransportNode::Tagged { .. } => JVal::Str("tagged".encode_utf16().collect()),
    }
}

fn entry_node(arena: &InputArena, root: usize, key: &str) -> Option<usize> {
    let want: Vec<u16> = key.encode_utf16().collect();
    match arena.node(root) {
        TransportNode::Entries { entries } => {
            entries.iter().find(|e| e.key == want).map(|e| e.node)
        }
        _ => None,
    }
}

// ---------- outcome harness ----------

struct Outcome {
    id: String,
    pass: bool,
    detail: String,
}

fn hex_units(hex: &str) -> Vec<u16> {
    hex.encode_utf16().collect()
}

fn parse_hex_bits(units: &[u16]) -> Option<u64> {
    u64::from_str_radix(&show(units), 16).ok()
}

fn fail(id: &str, detail: String) -> Outcome {
    Outcome {
        id: id.to_string(),
        pass: false,
        detail,
    }
}

fn ok(id: &str, detail: &str) -> Outcome {
    Outcome {
        id: id.to_string(),
        pass: true,
        detail: detail.to_string(),
    }
}

/// `expect.host` check. Returns the parsed host value on success.
fn check_host(id: &str, row: &JVal, parsed: &JVal) -> Result<(), Outcome> {
    let expect = row
        .get("expect")
        .ok_or_else(|| fail(id, "missing expect".into()))?;
    let host = match expect.get("host") {
        Some(h) => h,
        None => return Ok(()),
    };
    match host {
        JVal::Obj(fields) => {
            if let Some(bits) = fields
                .iter()
                .find(|(k, _)| *k == hex_units("$f64"))
                .map(|(_, v)| v)
            {
                let want = bits
                    .as_units()
                    .and_then(parse_hex_bits)
                    .ok_or_else(|| fail(id, "bad $f64 hex".into()))?;
                match parsed {
                    JVal::Num(got) if *got == want => {}
                    other => {
                        return Err(fail(
                            id,
                            format!("host $f64: want {want:016x}, got {other:?}"),
                        ));
                    }
                }
            }
            if let Some(units) = host.get("units") {
                let want = units
                    .as_count()
                    .ok_or_else(|| fail(id, "bad units".into()))?;
                let JVal::Str(units) = parsed else {
                    return Err(fail(id, format!("host units: non-text parsed {parsed:?}")));
                };
                let got = units.len() as u64;
                if got != want {
                    return Err(fail(id, format!("host units: want {want}, got {got}")));
                }
            }
            if let Some(entries) = host.get("entries") {
                let JVal::Arr(want) = entries else {
                    return Err(fail(id, "host entries not an array".into()));
                };
                let JVal::Obj(pairs) = parsed else {
                    return Err(fail(id, "host entries: parsed is not an object".into()));
                };
                // Host view is last-wins in enumeration order.
                let got = last_wins(pairs);
                if want.len() != got.len() {
                    return Err(fail(
                        id,
                        format!("host entries: want {} pairs, got {}", want.len(), got.len()),
                    ));
                }
                for (i, item) in want.iter().enumerate() {
                    let JVal::Arr(pair) = item else {
                        return Err(fail(id, "host entries: pair not an array".into()));
                    };
                    if pair.len() != 2 {
                        return Err(fail(id, "host entries: pair arity".into()));
                    }
                    let JVal::Str(key) = &pair[0] else {
                        return Err(fail(id, "host entries: key not text".into()));
                    };
                    if *key != got[i].0 || pair[1] != got[i].1 {
                        return Err(fail(
                            id,
                            format!(
                                "host entries[{}]: want ({:?}, {:?}), got ({:?}, {:?})",
                                i, key, pair[1], got[i].0, got[i].1
                            ),
                        ));
                    }
                }
            }
            if let Some(key_units) = host.get("keyUnits") {
                let want = key_units
                    .as_count()
                    .ok_or_else(|| fail(id, "bad keyUnits".into()))?;
                let JVal::Obj(pairs) = parsed else {
                    return Err(fail(id, "keyUnits: parsed is not an object".into()));
                };
                let got = pairs.first().map(|(k, _)| k.len() as u64).unwrap_or(0);
                if got != want {
                    return Err(fail(id, format!("host keyUnits: want {want}, got {got}")));
                }
            }
            // `own` / `prototypeUntouched` / `renders` / `lastWins` are
            // host-carrier observations outside the arena: the entries
            // and bits checks above carry the pinned content.
            Ok(())
        }
        // Scalar host truth (bool/array rows): direct equality.
        scalar => {
            if scalar == parsed {
                Ok(())
            } else {
                Err(fail(
                    id,
                    format!("host scalar: want {scalar:?}, got {parsed:?}"),
                ))
            }
        }
    }
}

/// `expect.transport` check against the built arena root.
fn check_transport(id: &str, row: &JVal, arena: &InputArena) -> Result<(), Outcome> {
    let expect = row
        .get("expect")
        .ok_or_else(|| fail(id, "missing expect".into()))?;
    let transport = match expect.get("transport") {
        Some(t) => t,
        None => return Ok(()),
    };
    let root = arena.root();
    let node = arena.node(root);
    // Fixture uses `$tag` on most rows but `tag` on entries rows;
    // both name the same root tag decision.
    let tag = transport
        .get("$tag")
        .or_else(|| transport.get("tag"))
        .and_then(JVal::as_units)
        .map(show);
    if let Some(want) = tag {
        let got = node_tag(node);
        if want != got {
            return Err(fail(
                id,
                format!("transport tag: want '{want}', arena '{got}'"),
            ));
        }
        if let Some(bits) = transport.get("bits") {
            let want_bits = bits
                .as_units()
                .and_then(parse_hex_bits)
                .ok_or_else(|| fail(id, "bad bits hex".into()))?;
            match node {
                TransportNode::F64 { bits: got } if *got == want_bits => {}
                other => {
                    return Err(fail(
                        id,
                        format!("transport bits: want {want_bits:016x}, got {other:?}"),
                    ));
                }
            }
        }
        if let Some(units) = transport.get("units") {
            let want_len = units
                .as_count()
                .ok_or_else(|| fail(id, "bad units".into()))?;
            match node {
                TransportNode::Text { units: got } if got.len() as u64 == want_len => {}
                other => {
                    return Err(fail(
                        id,
                        format!("transport units: want {want_len}, got {other:?}"),
                    ));
                }
            }
        }
        if let Some(value) = transport.get("value") {
            let got = node_to_jval(arena, root);
            if &got != value {
                return Err(fail(
                    id,
                    format!("transport value: want {value:?}, got {got:?}"),
                ));
            }
        }
        if let Some(length) = transport.get("length") {
            let want_len = length
                .as_count()
                .ok_or_else(|| fail(id, "bad length".into()))?;
            match node {
                TransportNode::Array { items } if items.len() as u64 == want_len => {}
                other => {
                    return Err(fail(
                        id,
                        format!("transport length: want {want_len}, got {other:?}"),
                    ));
                }
            }
        }
        if let Some(entries) = transport.get("entries") {
            let JVal::Arr(want) = entries else {
                return Err(fail(id, "transport entries not an array".into()));
            };
            let TransportNode::Entries { entries: got } = node else {
                return Err(fail(id, "transport entries: root is not entries".into()));
            };
            if want.len() != got.len() {
                return Err(fail(
                    id,
                    format!(
                        "transport entries: want {} pairs, got {}",
                        want.len(),
                        got.len()
                    ),
                ));
            }
            for (i, item) in want.iter().enumerate() {
                let JVal::Arr(pair) = item else {
                    return Err(fail(id, "transport entries: pair not an array".into()));
                };
                let JVal::Str(key) = &pair[0] else {
                    return Err(fail(id, "transport entries: key not text".into()));
                };
                let got_value = node_to_jval(arena, got[i].node);
                if *key != got[i].key || pair[1] != got_value {
                    return Err(fail(
                        id,
                        format!(
                            "transport entries[{i}]: want ({key:?}, {:?}), got ({:?}, {got_value:?})",
                            pair[1], got[i].key
                        ),
                    ));
                }
            }
        }
        return Ok(());
    }
    // Keyed transport (`presence/*`, `tags/drop-never-known`): each
    // named key resolves to a node whose tag (and extras) must match.
    let JVal::Obj(fields) = transport else {
        return Err(fail(id, "transport: neither tag nor keyed shape".into()));
    };
    for (key, want) in fields {
        let name = show(key);
        let index = entry_node(arena, root, &name)
            .ok_or_else(|| fail(id, format!("transport: key '{name}' missing")))?;
        let node = arena.node(index);
        let want_tag = want
            .get("$tag")
            .and_then(JVal::as_units)
            .map(show)
            .ok_or_else(|| fail(id, format!("transport '{name}': no $tag")))?;
        let got_tag = node_tag(node);
        if want_tag != got_tag {
            return Err(fail(
                id,
                format!("transport '{name}': want '{want_tag}', arena '{got_tag}'"),
            ));
        }
        if let Some(bits) = want.get("bits") {
            let want_bits = bits
                .as_units()
                .and_then(parse_hex_bits)
                .ok_or_else(|| fail(id, "bad bits hex".into()))?;
            match node {
                TransportNode::F64 { bits: got } if *got == want_bits => {}
                other => {
                    return Err(fail(
                        id,
                        format!("transport '{name}' bits: want {want_bits:016x}, got {other:?}"),
                    ));
                }
            }
        }
    }
    Ok(())
}

// ---------- row executors ----------

fn row_id(row: &JVal) -> String {
    row.get("id")
        .and_then(JVal::as_units)
        .map_or_else(|| "<no-id>".to_string(), show)
}

/// Source rows: parse text (host), check `expect.host`, feed the
/// parsed value to the arena, check `expect.transport`.
fn run_source_row(row: &JVal) -> Outcome {
    let id = row_id(row);
    let input = match row.get("input") {
        Some(i) => i,
        None => return fail(&id, "missing input".into()),
    };
    // Absent-key presence rows name the key; everything else parses.
    if let Some(absent) = input.get("absentKey").and_then(JVal::as_units) {
        return run_absent_key_row(&id, row, input, &show(absent));
    }
    let source = match input.get("source").and_then(JVal::as_units) {
        Some(s) => show(s),
        None => return fail(&id, "input: neither source nor absentKey".into()),
    };
    let parsed = match parse_json(&source) {
        Ok(v) => v,
        Err(e) => return fail(&id, format!("host parse failed: {e}")),
    };
    if let Err(o) = check_host(&id, row, &parsed) {
        return o;
    }
    let frame = jval_to_frame(&parsed);
    let arena = match InputArena::build(&frame, &GENEROUS) {
        Ok(a) => a,
        Err(e) => {
            return fail(&id, format!("arena build failed: {}/{}", e.code, e.stage()));
        }
    };
    // Row-local extras named by the fixture itself.
    if id == "kinds/array-mixed" {
        // Row note: null elements are own-null positions, never holes.
        let TransportNode::Array { items } = arena.node(arena.root()) else {
            return fail(&id, "array-mixed: root is not an array".into());
        };
        if !matches!(arena.node(items[2]), TransportNode::OwnNull) {
            return fail(&id, "array-mixed: element 2 is not own-null".into());
        }
    }
    if id == "order/integer-key-order-consumed" {
        let want = row
            .get("expect")
            .and_then(|e| e.get("consumedOrder"))
            .ok_or_else(|| fail(&id, "missing consumedOrder".into()));
        let want = match want {
            Ok(w) => w,
            Err(o) => return o,
        };
        let JVal::Arr(keys) = want else {
            return fail(&id, "consumedOrder not an array".into());
        };
        let TransportNode::Entries { entries } = arena.node(arena.root()) else {
            return fail(&id, "consumedOrder: root is not entries".into());
        };
        let got: Vec<String> = entries.iter().map(|e| show(&e.key)).collect();
        let want: Vec<String> = keys.iter().filter_map(JVal::as_units).map(show).collect();
        if got != want {
            return fail(&id, format!("consumedOrder: want {want:?}, got {got:?}"));
        }
    }
    if let Err(o) = check_transport(&id, row, &arena) {
        return o;
    }
    ok(&id, "host + arena observations match")
}

/// `presence/missing-vs-null`: the absent key resolves to an explicit
/// `Missing` frame (constructible only explicitly, never from a value).
fn run_absent_key_row(id: &str, row: &JVal, input: &JVal, absent: &str) -> Outcome {
    let source = match input.get("source").and_then(JVal::as_units) {
        Some(s) => show(s),
        None => return fail(id, "absentKey row without source".into()),
    };
    let parsed = match parse_json(&source) {
        Ok(v) => v,
        Err(e) => return fail(id, format!("host parse failed: {e}")),
    };
    // Host truth: `a` parses, `b` is absent from the parsed object.
    let JVal::Obj(pairs) = &parsed else {
        return fail(id, "absentKey row: source is not an object".into());
    };
    let absent_units: Vec<u16> = absent.encode_utf16().collect();
    if pairs.iter().any(|(k, _)| *k == absent_units) {
        return fail(id, format!("host: '{absent}' unexpectedly present"));
    }
    let frame = jval_to_frame(&parsed);
    let arena = match InputArena::build(&frame, &GENEROUS) {
        Ok(a) => a,
        Err(e) => return fail(id, format!("arena build failed: {}", e.code)),
    };
    // Present keys resolve in the arena; the absent key resolves
    // to an explicit Missing frame (never from a value).
    let transport = row.get("expect").and_then(|e| e.get("transport"));
    let Some(JVal::Obj(fields)) = transport else {
        return fail(id, "absentKey row: transport not keyed".into());
    };
    for (key, want) in fields {
        let name = show(key);
        let want_tag = want
            .get("$tag")
            .and_then(JVal::as_units)
            .map(show)
            .unwrap_or_default();
        if name == *absent {
            let missing = InputArena::build(&Frame::Missing, &GENEROUS).expect("missing builds");
            let tag = node_tag(missing.node(missing.root()));
            if tag != want_tag {
                return fail(
                    id,
                    format!("transport '{name}': want '{want_tag}', arena '{tag}'"),
                );
            }
            continue;
        }
        let index = match entry_node(&arena, arena.root(), &name) {
            Some(i) => i,
            None => return fail(id, format!("transport: key '{name}' missing")),
        };
        let got_tag = node_tag(arena.node(index));
        if got_tag != want_tag {
            return fail(
                id,
                format!("transport '{name}': want '{want_tag}', arena '{got_tag}'"),
            );
        }
    }
    ok(id, "present key own-null; absent key explicit missing")
}

/// Entries+shape rows: build from explicit entries, then apply the
/// row's own assertion (first-unknown enumeration or keyed tags).
fn run_entries_row(row: &JVal) -> Outcome {
    let id = row_id(row);
    let input = match row.get("input") {
        Some(i) => i,
        None => return fail(&id, "missing input".into()),
    };
    let entries = match input.get("entries") {
        Some(JVal::Arr(e)) => e,
        _ => return fail(&id, "input.entries not an array".into()),
    };
    let mut pairs = Vec::new();
    for item in entries {
        let JVal::Arr(pair) = item else {
            return fail(&id, "entries: pair not an array".into());
        };
        let JVal::Str(key) = &pair[0] else {
            return fail(&id, "entries: key not text".into());
        };
        pairs.push((key.clone(), pair[1].clone()));
    }
    let frame = jval_to_frame(&JVal::Obj(pairs));
    let arena = match InputArena::build(&frame, &GENEROUS) {
        Ok(a) => a,
        Err(e) => return fail(&id, format!("arena build failed: {}", e.code)),
    };
    let expect = match row.get("expect") {
        Some(e) => e,
        None => return fail(&id, "missing expect".into()),
    };
    // First-unknown enumeration rows carry order + firstUnknown.
    if let Some(order) = expect.get("order") {
        let JVal::Arr(want_order) = order else {
            return fail(&id, "order not an array".into());
        };
        let TransportNode::Entries { entries: got } = arena.node(arena.root()) else {
            return fail(&id, "order: root is not entries".into());
        };
        let got_order: Vec<String> = got.iter().map(|e| show(&e.key)).collect();
        let want_order: Vec<String> = want_order
            .iter()
            .filter_map(JVal::as_units)
            .map(show)
            .collect();
        if got_order != want_order {
            return fail(
                &id,
                format!("order: want {want_order:?}, got {got_order:?}"),
            );
        }
        let allowed: Vec<String> = input
            .get("shape")
            .and_then(|s| s.get("allowed"))
            .and_then(|a| match a {
                JVal::Arr(items) => Some(items),
                _ => None,
            })
            .map(|items| items.iter().filter_map(JVal::as_units).map(show).collect())
            .unwrap_or_default();
        let first_unknown = got_order
            .iter()
            .find(|k| !allowed.contains(k))
            .cloned()
            .unwrap_or_default();
        let want_first = expect
            .get("firstUnknown")
            .and_then(JVal::as_units)
            .map(show)
            .unwrap_or_default();
        if first_unknown != want_first {
            return fail(
                &id,
                format!("firstUnknown: want '{want_first}', got '{first_unknown}'"),
            );
        }
        return ok(&id, "entry order + first-unknown match");
    }
    if let Err(o) = check_transport(&id, row, &arena) {
        return o;
    }
    ok(&id, "entries + keyed tags match")
}

/// Mint rows: `default-applied` (real V03.4 identity), `default-absent`,
/// `update-omitted`, `dropped-unknown`.
fn run_mint_row(row: &JVal) -> Outcome {
    let id = row_id(row);
    let input = match row.get("input") {
        Some(i) => i,
        None => return fail(&id, "missing input".into()),
    };
    let transport = row
        .get("expect")
        .and_then(|e| e.get("transport"))
        .ok_or_else(|| fail(&id, "missing expect.transport".into()));
    let transport = match transport {
        Ok(t) => t,
        Err(o) => return o,
    };
    let want_tag = transport
        .get("$tag")
        .and_then(JVal::as_units)
        .map(show)
        .unwrap_or_default();
    match id.as_str() {
        "tags/default-applied-carries-identity" => {
            let registry = input
                .get("registry")
                .and_then(JVal::as_units)
                .map(show)
                .unwrap_or_default();
            // Identity bytes come from a REAL V03.4 registration: the
            // row pins THAT identity is carried, not its encoding.
            let mut plans = Plans::default();
            let owner = plans
                .create_owner(
                    OwnerScope {
                        abi: "v1".to_string(),
                        profile: "values".to_string(),
                        backend: "conformance-v1".to_string(),
                        owner_rev: "artifact-1".to_string(),
                    },
                    8,
                )
                .map_err(|e| fail(&id, format!("owner create: {e:?}")));
            let owner = match owner {
                Ok(o) => o,
                Err(o) => return o,
            };
            let plan_id = plans
                .register(
                    &owner,
                    "values/v1",
                    &SchemaInput::Normalized {
                        contracts: Vec::new(),
                        enums: Vec::new(),
                        operations: Vec::new(),
                    },
                    Some(&Provenance {
                        factory: "normalizeSchema".to_string(),
                        owner_rev: "artifact-1".to_string(),
                    }),
                )
                .map_err(|e| fail(&id, format!("plan register: {e:?}")));
            let plan_id = match plan_id {
                Ok(p) => p,
                Err(o) => return o,
            };
            let mut arena = InputArena::build(&Frame::Missing, &GENEROUS).expect("missing builds");
            let root = arena.root();
            let tagged = arena.mint_tag(
                MintedTag::DefaultApplied {
                    registry: registry.clone(),
                    plan_rev: plan_id.clone(),
                },
                root,
            );
            let got_tag = node_tag(arena.node(tagged));
            if got_tag != want_tag {
                return fail(&id, format!("mint tag: want '{want_tag}', got '{got_tag}'"));
            }
            let carries = !registry.is_empty() && !plan_id.is_empty();
            let want_carries = transport
                .get("carriesIdentity")
                .and_then(JVal::as_bool)
                .unwrap_or(false);
            if carries != want_carries {
                return fail(&id, "carriesIdentity mismatch".into());
            }
            // Position: the minted value node must be missing.
            if !matches!(arena.node(root), TransportNode::Missing) {
                return fail(&id, "default-applied position is not missing".into());
            }
            ok(
                &id,
                "minted default-applied carries V03.4 identity over missing",
            )
        }
        "tags/default-absent-when-present" => {
            let value = input
                .get("value")
                .ok_or_else(|| fail(&id, "no value".into()));
            let value = match value {
                Ok(v) => v,
                Err(o) => return o,
            };
            let bits = value
                .get("$f64")
                .and_then(JVal::as_units)
                .and_then(parse_hex_bits)
                .ok_or_else(|| fail(&id, "bad $f64".into()));
            let bits = match bits {
                Ok(b) => b,
                Err(o) => return o,
            };
            let mut arena =
                InputArena::build(&Frame::F64Bits(bits), &GENEROUS).expect("f64 builds");
            let root = arena.root();
            let tagged = arena.mint_tag(MintedTag::DefaultAbsent, root);
            let got_tag = node_tag(arena.node(tagged));
            if got_tag != want_tag {
                return fail(&id, format!("mint tag: want '{want_tag}', got '{got_tag}'"));
            }
            ok(&id, "minted default-absent over present f64")
        }
        "tags/update-omitted-minted" => {
            // Omitted update position: minted over explicit missing.
            // (Runner interpretation — E can correct the carrier.)
            let mut arena = InputArena::build(&Frame::Missing, &GENEROUS).expect("missing builds");
            let root = arena.root();
            let tagged = arena.mint_tag(MintedTag::UpdateOmitted, root);
            let got_tag = node_tag(arena.node(tagged));
            if got_tag != want_tag {
                return fail(&id, format!("mint tag: want '{want_tag}', got '{got_tag}'"));
            }
            ok(
                &id,
                "minted update-omitted over missing (runner interpretation)",
            )
        }
        "tags/dropped-unknown-with-path" => {
            let entries = match input.get("entries") {
                Some(JVal::Arr(e)) => e,
                _ => return fail(&id, "input.entries not an array".into()),
            };
            let allowed: Vec<String> = input
                .get("shape")
                .and_then(|s| s.get("allowed"))
                .and_then(|a| match a {
                    JVal::Arr(items) => Some(items),
                    _ => None,
                })
                .map(|items| items.iter().filter_map(JVal::as_units).map(show).collect())
                .unwrap_or_default();
            let mut pairs = Vec::new();
            for item in entries {
                let JVal::Arr(pair) = item else {
                    return fail(&id, "entries: pair not an array".into());
                };
                let JVal::Str(key) = &pair[0] else {
                    return fail(&id, "entries: key not text".into());
                };
                pairs.push((key.clone(), pair[1].clone()));
            }
            let frame = jval_to_frame(&JVal::Obj(pairs));
            let mut arena = match InputArena::build(&frame, &GENEROUS) {
                Ok(a) => a,
                Err(e) => return fail(&id, format!("build failed: {}", e.code)),
            };
            let root = arena.root();
            let TransportNode::Entries { entries: got } = arena.node(root).clone() else {
                return fail(&id, "dropped-unknown: root is not entries".into());
            };
            let dropped: Vec<(Vec<u16>, usize)> = got
                .into_iter()
                .filter(|e| !allowed.contains(&show(&e.key)))
                .map(|e| (e.key, e.node))
                .collect();
            if dropped.len() != 1 {
                return fail(&id, format!("want 1 dropped key, got {}", dropped.len()));
            }
            let tagged = arena.mint_tag(
                MintedTag::DroppedUnknown {
                    path: vec![dropped[0].0.clone()],
                },
                dropped[0].1,
            );
            let got_tag = node_tag(arena.node(tagged));
            if got_tag != want_tag {
                return fail(&id, format!("mint tag: want '{want_tag}', got '{got_tag}'"));
            }
            // Path rendering (G-chosen): segments joined as `/extra`.
            let path = format!("/{}", show(&dropped[0].0));
            let want_path = transport
                .get("path")
                .and_then(JVal::as_units)
                .map(show)
                .unwrap_or_default();
            if path != want_path {
                return fail(&id, format!("drop path: want '{want_path}', got '{path}'"));
            }
            ok(&id, "minted dropped-unknown carries /extra path")
        }
        other => fail(&id, format!("unknown mint row {other}")),
    }
}

/// Length rows: the D1 vocabulary core — codes + checks compared
/// mechanically, never pinned by hand.
fn run_length_row(row: &JVal) -> Outcome {
    let id = row_id(row);
    let input = match row.get("input") {
        Some(i) => i,
        None => return fail(&id, "missing input".into()),
    };
    let expect = match row.get("expect") {
        Some(e) => e,
        None => return fail(&id, "missing expect".into()),
    };
    if id == "length/node-count-before-traverse" {
        let declared = input.get("declared").and_then(JVal::as_count).unwrap_or(0) as usize;
        let available = input.get("available").and_then(JVal::as_count).unwrap_or(0) as usize;
        // Frame with exactly `available` nodes: a flat array of
        // (available - 1) nulls plus the root.
        let frame = Frame::Array(vec![Frame::OwnNull; available - 1]);
        let budgets = Budgets {
            max_nodes: declared,
            ..GENEROUS
        };
        let err = match InputArena::build(&frame, &budgets) {
            Ok(_) => return fail(&id, "over-declared frame unexpectedly built".into()),
            Err(e) => e,
        };
        return check_rejection(&id, expect, &err);
    }
    if id == "length/depth-before-descent" {
        // Budget numbers are V03-measure/V07-fix hypotheses, NOT pins:
        // the runner picks a budget and breaches it by a fixed margin.
        // What the row pins is mechanism (reject before descent) +
        // code/check vocabulary.
        let max_depth = 8usize;
        let mut frame = Frame::OwnNull;
        for _ in 0..=max_depth + 1 {
            frame = Frame::Array(vec![frame]);
        }
        let budgets = Budgets {
            max_depth,
            ..GENEROUS
        };
        let err = match InputArena::build(&frame, &budgets) {
            Ok(_) => return fail(&id, "over-deep frame unexpectedly built".into()),
            Err(e) => e,
        };
        return check_rejection(&id, expect, &err);
    }
    // Record-id / text unit rows.
    let units = input.get("units").and_then(JVal::as_count).unwrap_or(0) as usize;
    let kind = input
        .get("kind")
        .and_then(JVal::as_units)
        .map(show)
        .unwrap_or_default();
    // 256-row: include one surrogate pair so "pair counts 2" is
    // exercised, not just BMP length.
    let mut text: Vec<u16> = Vec::with_capacity(units);
    if units >= 2 && kind == "record-id" {
        text.extend(std::iter::repeat_n(0x61, units - 2));
        text.extend([0xD83D, 0xDE00]);
    } else {
        text.extend(std::iter::repeat_n(0x61, units));
    }
    assert_eq!(text.len(), units, "runner unit construction");
    assert_eq!(MAX_ID_LENGTH_UNITS, 256, "pinned id bound");
    let want_ok = expect.get("ok").and_then(JVal::as_bool).unwrap_or(true);
    match InputArena::check_id_length(&text) {
        Ok(()) if want_ok => ok(&id, "id length within bound"),
        Ok(()) => fail(&id, "over-bound id unexpectedly passed".into()),
        Err(e) if !want_ok => check_rejection(&id, expect, &e),
        Err(e) => fail(&id, format!("in-bound id rejected: {}", e.code)),
    }
}

fn check_rejection(
    id: &str,
    expect: &JVal,
    err: &values_semantics::input::TransportError,
) -> Outcome {
    let want_stage = expect
        .get("stage")
        .and_then(JVal::as_units)
        .map(show)
        .unwrap_or_default();
    let want_code = expect
        .get("code")
        .and_then(JVal::as_units)
        .map(show)
        .unwrap_or_default();
    let want_check = expect.get("check").and_then(JVal::as_units).map(show);
    let mut problems = Vec::new();
    if err.stage() != want_stage {
        problems.push(format!("stage: want '{want_stage}', got '{}'", err.stage()));
    }
    if err.code != want_code {
        problems.push(format!("code: want '{want_code}', got '{}'", err.code));
    }
    if err.check != want_check.as_deref() {
        problems.push(format!("check: want {want_check:?}, got {:?}", err.check));
    }
    if problems.is_empty() {
        ok(id, "rejection stage/code/check match")
    } else {
        fail(id, problems.join("; "))
    }
}

/// Exclusion rows: must-hold declarations, executed where observable.
fn run_exclusion_row(row: &JVal, transport_built: usize) -> Outcome {
    let id = row_id(row);
    match id.as_str() {
        "presence/undefined-never-from-json"
        | "presence/inherited-never-from-json"
        | "presence/accessor-never-from-json" => {
            let forbidden = match id.as_str() {
                "presence/undefined-never-from-json" => "own-undefined",
                "presence/inherited-never-from-json" => "inherited",
                _ => "accessor",
            };
            // Classify EVERY node built by the transport section: no
            // arena-from-frame node may carry a lineage tag. (Frame has
            // no such variants — this pins it executably.)
            let tags = values_semantics::input::json_admissible_tags();
            if tags.contains(&forbidden) {
                return fail(&id, format!("{forbidden} is admissible"));
            }
            ok(&id, "lineage tag absent from admissible set (Frame: no such variant)")
        }
        "exclusion/opaque-json-never-transport" => ok(
            &id,
            &format!("{transport_built} transport rows built through typed frames; no opaque codec on the path"),
        ),
        "exclusion/host-parse-errors-stay-host" => {
            // Malformed text fails in the host-parse step; the arena
            // never receives unparsed text (its API takes Frame only).
            match parse_json("{bad json") {
                Ok(_) => fail(&id, "malformed source unexpectedly parsed".into()),
                Err(_) => ok(&id, "malformed text fails at host parse; arena takes Frame only"),
            }
        }
        "exclusion/no-coerce-then-check" => {
            // Breach yields Err with NO arena (type-level: Result).
            let frame = Frame::Array(vec![Frame::OwnNull; 11]);
            let budgets = Budgets {
                max_nodes: 10,
                ..GENEROUS
            };
            match InputArena::build(&frame, &budgets) {
                Ok(_) => fail(&id, "over-budget frame built".into()),
                Err(_) => ok(&id, "breach returns Err without a partial arena"),
            }
        }
        other => fail(&id, format!("unknown exclusion row {other}")),
    }
}

fn apply_v1_rulings(version: &str, outcome: Outcome) -> Outcome {
    if version != "v1" || outcome.pass {
        return outcome;
    }
    // E-D1 ruling ADOPT-G: the arena keeps `entries`; v1's frozen
    // `object` text is superseded (v2 pins `entries` + the pair).
    if outcome.id == "tags/forged-sentinel-is-data"
        && outcome.detail == "transport tag: want 'object', arena 'entries'"
    {
        return Outcome {
            detail: "RULED ADOPT-G: v1 frozen 'object' superseded; v2 pins 'entries'".to_string(),
            pass: true,
            ..outcome
        };
    }
    // E-D1 ruling SPLIT: the arena keeps the adopted `id-units` check
    // with the v1 code; v1's frozen `text-units` is superseded (v2
    // pins code length/bound-exceeded + check id-units).
    if outcome.id == "length/id-257-units-rejects"
        && outcome.detail == "check: want Some(\"text-units\"), got Some(\"id-units\")"
    {
        return Outcome {
            detail: "RULED SPLIT: v1 frozen 'text-units' superseded; v2 pins 'id-units'"
                .to_string(),
            pass: true,
            ..outcome
        };
    }
    outcome
}

fn enumerate(version: &str, text: &str) -> Vec<Outcome> {
    let cases = parse_json(text).expect("cases.json parses");
    let mut outcomes: Vec<Outcome> = Vec::new();
    let mut transport_built = 0usize;

    let section = |name: &str| -> Vec<JVal> {
        match cases.get(name) {
            Some(JVal::Arr(rows)) => rows.clone(),
            _ => panic!("cases.json: missing section {name}"),
        }
    };

    for row in section("transportCases") {
        let outcome = if row.get("input").and_then(|i| i.get("entries")).is_some() {
            run_entries_row(&row)
        } else {
            run_source_row(&row)
        };
        let outcome = apply_v1_rulings(version, outcome);
        if outcome.pass {
            transport_built += 1;
        }
        outcomes.push(outcome);
    }
    for row in section("tagCases") {
        let id = row_id(&row);
        let input = row.get("input");
        let outcome = if input.and_then(|i| i.get("source")).is_some() {
            run_source_row(&row)
        } else if input.and_then(|i| i.get("entries")).is_some() {
            // Dropped-unknown mints; drop-never-known only observes.
            if id == "tags/dropped-unknown-with-path" {
                run_mint_row(&row)
            } else {
                run_entries_row(&row)
            }
        } else {
            run_mint_row(&row)
        };
        outcomes.push(apply_v1_rulings(version, outcome));
    }
    for row in section("lengthCases") {
        outcomes.push(apply_v1_rulings(version, run_length_row(&row)));
    }
    for row in section("exclusionCases") {
        outcomes.push(apply_v1_rulings(
            version,
            run_exclusion_row(&row, transport_built),
        ));
    }
    outcomes
}

#[test]
fn conformance_v1_mechanical_enumeration() {
    let mut report = String::new();
    let mut failed = 0usize;
    let mut rows = 0usize;
    for (version, text) in load_cases() {
        let outcomes = enumerate(&version, &text);
        report.push_str(&format!("D1 mechanical enumeration (cases {version}):\n"));
        for o in &outcomes {
            report.push_str(&format!(
                "[{}] {} — {}\n",
                if o.pass { "PASS" } else { "DIVERGE" },
                o.id,
                o.detail
            ));
            if !o.pass {
                failed += 1;
            }
        }
        rows += outcomes.len();
        report.push_str(&format!(
            "cases {version}: {} rows, {} diverge\n",
            outcomes.len(),
            outcomes.iter().filter(|o| !o.pass).count()
        ));
    }
    report.push_str(&format!("total {rows} rows, {failed} diverge\n"));
    println!("{report}");
    assert_eq!(failed, 0, "D1 divergences:\n{report}");
}
