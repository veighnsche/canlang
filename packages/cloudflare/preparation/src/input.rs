//! Lossless admitted-tree transport (P03.2).
//!
//! The host (`inputs.ts`) encodes a parsed JSON artifact tree as
//! ordered tagged nodes; this module decodes them with checked
//! limits. Strings and keys travel as explicit UTF-16 code units
//! (lone surrogates survive: raw JSON text cannot carry them through
//! UTF-8); numbers travel as f64 bits plus the host canonical
//! spelling; objects travel as ordered key/value entry arrays so
//! insertion order and own `__proto__` survive.
//!
//! Wire tags (JSON): `null`, `bool`, `num`, `text`, `arr`, `obj`.
//! - num:  `{t:"num", bits:"<16 hex lowercase>", spelling:"<JSON.stringify(n)>"}` —
//!   bits are authoritative for identity; spelling is authoritative
//!   for rendering (host `JSON.stringify` rules: nonfinite→null).
//! - text: `{t:"text", units:[u16,...]}` in logical order.
//! - arr:  `{t:"arr", items:[node,...]}`.
//! - obj:  `{t:"obj", entries:[[[u16,...], node],...]}` — entries in
//!   host enumeration order; duplicate keys impossible post-parse.

// Staged: P03.3/P04 wire `decode_tree` into the job loop; unit tests
// below already pin the wire contract. Remove when consumed.
#![allow(dead_code)]

use crate::failures::transport;
use serde::Deserialize;

/// Maximum nesting depth (root = 1). Transfer bound, not a language
/// limit: the tagged-JSON wire form nests ~3-5 JSON levels per node
/// level, and serde_json enforces its own 128-recursion cap first.
/// Bracket pre-scan (below) keeps every accepted input well under
/// serde's trip point, so THIS check stays authoritative with the
/// documented code. Real artifacts nest <10; P10.1 validates maxima
/// against real inputs. Native-path only; the TS path is unchanged.
pub const MAX_TREE_DEPTH: usize = 32;
/// Maximum raw bracket nesting accepted before JSON parsing.
/// String-aware scan; over-limit inputs fail `tree-too-deep` without
/// allocating. Set safely under serde_json's 128 recursion cap so
/// depth rejections always carry our code, never a parser error.
pub const MAX_BRACKET_NESTING: usize = 100;
/// Maximum total decoded nodes per tree.
pub const MAX_TREE_NODES: usize = 1_048_576;
/// Maximum total UTF-16 code units per tree.
pub const MAX_TREE_UNITS: usize = 16_777_216;

/// Decoded lossless node. Text is code units, never Rust `String`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Null,
    Bool(bool),
    Num { bits: u64, spelling: String },
    Text(Vec<u16>),
    Arr(Vec<Node>),
    Obj(Vec<(Vec<u16>, Node)>),
}

#[derive(Debug, Deserialize)]
struct WireNode {
    t: String,
    #[serde(default)]
    v: Option<bool>,
    #[serde(default)]
    bits: Option<String>,
    #[serde(default)]
    spelling: Option<String>,
    #[serde(default)]
    units: Option<Vec<u16>>,
    #[serde(default)]
    items: Option<Vec<WireNode>>,
    #[serde(default)]
    entries: Option<Vec<(Vec<u16>, WireNode)>>,
}

/// Shared admitted-tree accessors (P04.2): algorithm lanes read
/// validated facts through these; each mirrors one JS predicate.
pub fn units_eq(units: &[u16], text: &str) -> bool {
    units.len() == text.len() && units.iter().zip(text.bytes()).all(|(u, b)| *u == b as u16)
}

/// Object member lookup by ASCII key (`undefined` when absent or not an object).
pub fn obj_get<'a>(node: &'a Node, key: &str) -> Option<&'a Node> {
    match node {
        Node::Obj(entries) => entries
            .iter()
            .find(|(k, _)| units_eq(k, key))
            .map(|(_, v)| v),
        _ => None,
    }
}

pub fn as_text(node: &Node) -> Option<&Vec<u16>> {
    match node {
        Node::Text(units) => Some(units),
        _ => None,
    }
}

pub fn nonempty_text(node: &Node) -> Option<&Vec<u16>> {
    as_text(node).filter(|units| !units.is_empty())
}

pub fn as_num(node: &Node) -> Option<(u64, &str)> {
    match node {
        Node::Num { bits, spelling } => Some((*bits, spelling.as_str())),
        _ => None,
    }
}

pub fn as_arr(node: &Node) -> Option<&Vec<Node>> {
    match node {
        Node::Arr(items) => Some(items),
        _ => None,
    }
}

pub fn as_obj(node: &Node) -> Option<&Vec<(Vec<u16>, Node)>> {
    match node {
        Node::Obj(entries) => Some(entries),
        _ => None,
    }
}

pub fn as_bool(node: &Node) -> Option<bool> {
    match node {
        Node::Bool(v) => Some(*v),
        _ => None,
    }
}

/// WTF-16 → Unicode for rendered detail strings. Matches Node's
/// stdout encoding (lone surrogates become U+FFFD); all well-formed
/// text renders byte-exactly.
pub fn render_text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Exact `JSON.stringify` for a string over UTF-16 units: quotes
/// only `"`, `\` and C0 controls (short escapes where JS has them);
/// lone surrogates become lowercase `\uXXXX`; pairs and the rest
/// pass raw.
pub fn json_quote(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            0x00..=0x1F => {
                out.push_str(&format!("\\u{u:04x}"));
            }
            0xD800..=0xDBFF => {
                if i + 1 < units.len() && (0xDC00..=0xDFFF).contains(&units[i + 1]) {
                    let hi = u as u32 - 0xD800;
                    let lo = units[i + 1] as u32 - 0xDC00;
                    // Valid pair: always a defined scalar value.
                    if let Some(ch) = char::from_u32(0x1_0000 + (hi << 10) + lo) {
                        out.push(ch);
                    }
                    i += 1;
                } else {
                    out.push_str(&format!("\\u{u:04x}"));
                }
            }
            0xDC00..=0xDFFF => {
                out.push_str(&format!("\\u{u:04x}"));
            }
            _ => {
                // BMP scalar: every non-surrogate unit is a valid char.
                out.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}'));
            }
        }
        i += 1;
    }
    out.push('"');
    out
}

/// JS `String(value)` over reachable shapes. Numbers use canonical
/// spellings (parsed-domain numbers are finite, where `String(n)`
/// equals `JSON.stringify(n)`); arrays join with commas; objects
/// render `[object Object]`.
pub fn js_string(node: &Node) -> String {
    match node {
        Node::Null => "null".to_string(),
        Node::Bool(true) => "true".to_string(),
        Node::Bool(false) => "false".to_string(),
        Node::Num { spelling, .. } => spelling.clone(),
        Node::Text(units) => render_text(units),
        Node::Arr(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Node::Obj(_) => "[object Object]".to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    pub code: &'static str,
    pub detail: String,
}

impl DecodeError {
    fn new(code: &'static str, detail: String) -> Self {
        DecodeError { code, detail }
    }
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

struct Budget {
    nodes: usize,
    units: usize,
}

fn hex_u64(text: &str) -> Option<u64> {
    if text.len() != 16 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(text, 16).ok()
}

fn decode_node(wire: &WireNode, depth: usize, budget: &mut Budget) -> Result<Node, DecodeError> {
    if depth > MAX_TREE_DEPTH {
        return Err(DecodeError::new(
            transport::TREE_TOO_DEEP,
            format!("depth {depth} exceeds {MAX_TREE_DEPTH}"),
        ));
    }
    budget.nodes += 1;
    if budget.nodes > MAX_TREE_NODES {
        return Err(DecodeError::new(
            transport::TREE_TOO_MANY_NODES,
            format!("nodes exceed {MAX_TREE_NODES}"),
        ));
    }
    let charge_units = |budget: &mut Budget, n: usize| -> Result<(), DecodeError> {
        budget.units += n;
        if budget.units > MAX_TREE_UNITS {
            return Err(DecodeError::new(
                transport::TREE_TOO_MANY_UNITS,
                format!("units exceed {MAX_TREE_UNITS}"),
            ));
        }
        Ok(())
    };
    match wire.t.as_str() {
        "null" => Ok(Node::Null),
        "bool" => match wire.v {
            Some(v) => Ok(Node::Bool(v)),
            None => Err(DecodeError::new(
                transport::BAD_NODE,
                "bool node lacks v".into(),
            )),
        },
        "num" => {
            let bits = wire.bits.as_deref().and_then(hex_u64).ok_or_else(|| {
                DecodeError::new(transport::BAD_NODE, "num node needs 16-hex bits".into())
            })?;
            let spelling = wire.spelling.clone().ok_or_else(|| {
                DecodeError::new(transport::BAD_NODE, "num node lacks spelling".into())
            })?;
            Ok(Node::Num { bits, spelling })
        }
        "text" => {
            let units = wire.units.clone().ok_or_else(|| {
                DecodeError::new(transport::BAD_NODE, "text node lacks units".into())
            })?;
            charge_units(budget, units.len())?;
            Ok(Node::Text(units))
        }
        "arr" => {
            let items = wire.items.as_ref().ok_or_else(|| {
                DecodeError::new(transport::BAD_NODE, "arr node lacks items".into())
            })?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(decode_node(item, depth + 1, budget)?);
            }
            Ok(Node::Arr(out))
        }
        "obj" => {
            let entries = wire.entries.as_ref().ok_or_else(|| {
                DecodeError::new(transport::BAD_NODE, "obj node lacks entries".into())
            })?;
            let mut out = Vec::with_capacity(entries.len());
            for (key, value) in entries {
                charge_units(budget, key.len())?;
                out.push((key.clone(), decode_node(value, depth + 1, budget)?));
            }
            Ok(Node::Obj(out))
        }
        other => Err(DecodeError::new(
            transport::BAD_NODE,
            format!("unknown node tag {other:?}"),
        )),
    }
}

/// String-aware bracket scan: max `[{` nesting outside strings.
/// Over-limit inputs reject before serde sees them (see constant docs).
fn check_bracket_nesting(json: &[u8]) -> Result<(), DecodeError> {
    let mut depth = 0usize;
    let mut max = 0usize;
    let mut in_string = false;
    let mut escape = false;
    for &b in json {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                max = max.max(depth);
                if max > MAX_BRACKET_NESTING {
                    return Err(DecodeError::new(
                        transport::TREE_TOO_DEEP,
                        format!("bracket nesting exceeds {MAX_BRACKET_NESTING}"),
                    ));
                }
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    Ok(())
}

/// Decode one tagged tree from its JSON bytes with checked limits.
pub fn decode_tree(json: &[u8]) -> Result<Node, DecodeError> {
    check_bracket_nesting(json)?;
    let wire: WireNode = serde_json::from_slice(json)
        .map_err(|e| DecodeError::new(transport::BAD_NODE, format!("tree is not a node: {e}")))?;
    let mut budget = Budget { nodes: 0, units: 0 };
    decode_node(&wire, 1, &mut budget)
}

/// Encode one node to the tagged wire JSON (P04.4 `ACTIVATION_REQUEST`
/// carries the core-computed installed facts back to the host in this
/// form: the host already holds the other `activate()` inputs, and the
/// core's installed reading stays the single authority). Shapes mirror
/// `inputs.ts encodeNode` exactly (`num` bits are 16 lowercase hex).
pub fn encode_tree(node: &Node) -> serde_json::Value {
    match node {
        Node::Null => serde_json::json!({"t": "null"}),
        Node::Bool(v) => serde_json::json!({"t": "bool", "v": v}),
        Node::Num { bits, spelling } => serde_json::json!({
            "t": "num",
            "bits": format!("{bits:016x}"),
            "spelling": spelling,
        }),
        Node::Text(units) => serde_json::json!({"t": "text", "units": units}),
        Node::Arr(items) => serde_json::json!({
            "t": "arr",
            "items": items.iter().map(encode_tree).collect::<Vec<_>>(),
        }),
        Node::Obj(entries) => serde_json::json!({
            "t": "obj",
            "entries": entries
                .iter()
                .map(|(key, value)| serde_json::json!([key, encode_tree(value)]))
                .collect::<Vec<_>>(),
        }),
    }
}

/// Parse plain (untagged) JSON text over UTF-16 units into a `Node`.
///
/// The tagged wire (`decode_tree`) cannot serve here: `serde_json`
/// sorts object keys, which would break byte parity for rendered
/// assembly metadata (`sourceMaps` insertion order, verdict key
/// order). This parser preserves object entry order and number
/// source spellings exactly; strings keep lone surrogates as units
/// (the same transport contract as tagged text) while `\u` escapes
/// keep surrogate pairs as unit pairs. Duplicate object keys refuse
/// (the tagged wire makes them impossible post-parse; fail-closed
/// here). Depth is bounded by `MAX_TREE_DEPTH` like the tagged
/// decoder. Numbers must be finite: a non-finite value cannot
/// re-render (`JSON.stringify` would emit `null`).
pub fn parse_json_text(units: &[u16]) -> Result<Node, String> {
    let mut parser = JsonParser { units, at: 0 };
    parser.skip_ws();
    let node = parser.value(1)?;
    parser.skip_ws();
    if parser.at != units.len() {
        return Err("JSON text has trailing content".to_string());
    }
    Ok(node)
}

/// ASCII digit over a UTF-16 unit (the `u8` helper has no `u16` twin).
fn is_ascii_digit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39)
}

struct JsonParser<'a> {
    units: &'a [u16],
    at: usize,
}

impl<'a> JsonParser<'a> {
    fn peek(&self) -> Option<u16> {
        self.units.get(self.at).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(0x20) | Some(0x09) | Some(0x0A) | Some(0x0D)) {
            self.at += 1;
        }
    }

    fn expect(&mut self, unit: u16, what: &str) -> Result<(), String> {
        if self.peek() == Some(unit) {
            self.at += 1;
            Ok(())
        } else {
            Err(format!("JSON text expects {what}"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Node, String> {
        if depth > MAX_TREE_DEPTH {
            return Err("JSON text nests too deep".to_string());
        }
        match self.peek() {
            None => Err("JSON text ends mid-value".to_string()),
            Some(0x6E) => self.literal("null", Node::Null),     // n
            Some(0x74) => self.literal("true", Node::Bool(true)), // t
            Some(0x66) => self.literal("false", Node::Bool(false)), // f
            Some(0x22) => Ok(Node::Text(self.string()?)),       // "
            Some(0x5B) => self.array(depth),                    // [
            Some(0x7B) => self.object(depth),                   // {
            Some(u) if u == 0x2D || is_ascii_digit(u) => self.number(),
            _ => Err("JSON text has an unexpected value".to_string()),
        }
    }

    fn literal(&mut self, word: &str, node: Node) -> Result<Node, String> {
        for expected in word.bytes() {
            if self.peek() != Some(expected as u16) {
                return Err("JSON text has an unexpected literal".to_string());
            }
            self.at += 1;
        }
        Ok(node)
    }

    fn hex(unit: u16) -> Option<u32> {
        match unit {
            0x30..=0x39 => Some((unit - 0x30) as u32),
            0x41..=0x46 => Some((unit - 0x41 + 10) as u32),
            0x61..=0x66 => Some((unit - 0x61 + 10) as u32),
            _ => None,
        }
    }

    fn escape_unit(&mut self) -> Result<Vec<u16>, String> {
        let bad = || "JSON text has a bad string escape".to_string();
        match self.peek() {
            Some(0x22) => Ok(vec![0x22]),
            Some(0x5C) => Ok(vec![0x5C]),
            Some(0x2F) => Ok(vec![0x2F]),
            Some(0x62) => Ok(vec![0x08]),
            Some(0x66) => Ok(vec![0x0C]),
            Some(0x6E) => Ok(vec![0x0A]),
            Some(0x72) => Ok(vec![0x0D]),
            Some(0x74) => Ok(vec![0x09]),
            Some(0x75) => {
                // \uXXXX: one unit; a high surrogate keeps its pair
                // as two units (the units domain never merges them).
                let mut digits = 0u32;
                for _ in 0..4 {
                    self.at += 1;
                    digits = digits * 16
                        + Self::hex(self.peek().ok_or_else(bad)?).ok_or_else(bad)?;
                }
                Ok(vec![digits as u16])
            }
            _ => Err(bad()),
        }
    }

    fn string(&mut self) -> Result<Vec<u16>, String> {
        self.expect(0x22, "a string")?;
        let mut out = Vec::new();
        loop {
            match self.peek() {
                None => return Err("JSON text ends mid-string".to_string()),
                Some(0x22) => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(0x5C) => {
                    self.at += 1;
                    out.extend(self.escape_unit()?);
                    // The escape consumed its introducer; advance past
                    // the escape body (one unit, or four hex digits).
                    self.at += 1;
                }
                Some(u) if u < 0x20 => {
                    return Err("JSON text has a literal control in a string".to_string());
                }
                Some(u) => {
                    out.push(u);
                    self.at += 1;
                }
            }
        }
    }

    fn digits(&mut self, what: &str) -> Result<(), String> {
        let start = self.at;
        while self.peek().is_some_and(is_ascii_digit) {
            self.at += 1;
        }
        if self.at == start {
            return Err(format!("JSON text expects {what}"));
        }
        Ok(())
    }

    fn number(&mut self) -> Result<Node, String> {
        let start = self.at;
        if self.peek() == Some(0x2D) {
            self.at += 1;
        }
        match self.peek() {
            Some(0x30) => self.at += 1,
            Some(u) if is_ascii_digit(u) => self.digits("integer digits")?,
            _ => return Err("JSON text has a bad number".to_string()),
        }
        if self.peek() == Some(0x2E) {
            self.at += 1;
            self.digits("fraction digits")?;
        }
        if matches!(self.peek(), Some(0x65) | Some(0x45)) {
            self.at += 1;
            if matches!(self.peek(), Some(0x2B) | Some(0x2D)) {
                self.at += 1;
            }
            self.digits("exponent digits")?;
        }
        let spelling: String = self.units[start..self.at]
            .iter()
            .map(|u| char::from_u32(*u as u32).unwrap_or('\u{FFFD}'))
            .collect();
        let value: f64 = spelling
            .parse()
            .map_err(|_| "JSON text has an unparsable number".to_string())?;
        if !value.is_finite() {
            return Err("JSON text has a non-finite number".to_string());
        }
        Ok(Node::Num {
            bits: value.to_bits(),
            spelling,
        })
    }

    fn array(&mut self, depth: usize) -> Result<Node, String> {
        self.expect(0x5B, "'['")?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(0x5D) {
            self.at += 1;
            return Ok(Node::Arr(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value(depth + 1)?);
            self.skip_ws();
            match self.peek() {
                Some(0x2C) => self.at += 1,
                Some(0x5D) => {
                    self.at += 1;
                    return Ok(Node::Arr(items));
                }
                _ => return Err("JSON text expects ',' or ']'".to_string()),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Node, String> {
        self.expect(0x7B, "'{'")?;
        let mut entries: Vec<(Vec<u16>, Node)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(0x7D) {
            self.at += 1;
            return Ok(Node::Obj(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(0x22) {
                return Err("JSON text expects a string key".to_string());
            }
            let key = self.string()?;
            self.skip_ws();
            self.expect(0x3A, "':'")?;
            self.skip_ws();
            let item = self.value(depth + 1)?;
            self.skip_ws();
            if entries.iter().any(|(k, _)| k == &key) {
                return Err("JSON text repeats an object key".to_string());
            }
            entries.push((key, item));
            match self.peek() {
                Some(0x2C) => self.at += 1,
                Some(0x7D) => {
                    self.at += 1;
                    return Ok(Node::Obj(entries));
                }
                _ => return Err("JSON text expects ',' or '}'".to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(json: &str) -> Result<Node, DecodeError> {
        decode_tree(json.as_bytes())
    }

    #[test]
    fn scalars_round_trip() {
        assert_eq!(decode(r#"{"t":"null"}"#).unwrap(), Node::Null);
        assert_eq!(
            decode(r#"{"t":"bool","v":true}"#).unwrap(),
            Node::Bool(true)
        );
        assert_eq!(
            decode(r#"{"t":"num","bits":"0000000000000000","spelling":"0"}"#).unwrap(),
            Node::Num {
                bits: 0,
                spelling: "0".into()
            }
        );
    }

    #[test]
    fn negative_zero_keeps_bits_and_spelling() {
        // Host JSON.stringify(-0) === "0"; bits carry the distinction.
        assert_eq!(
            decode(r#"{"t":"num","bits":"8000000000000000","spelling":"0"}"#).unwrap(),
            Node::Num {
                bits: 0x8000_0000_0000_0000,
                spelling: "0".into()
            }
        );
    }

    #[test]
    fn nonfinite_and_exponent_forms() {
        assert_eq!(
            decode(r#"{"t":"num","bits":"7ff0000000000000","spelling":"null"}"#).unwrap(),
            Node::Num {
                bits: 0x7ff0_0000_0000_0000,
                spelling: "null".into()
            }
        );
        // 1e400 parses to Infinity; spelling follows JSON.stringify.
        assert_eq!(
            decode(r#"{"t":"num","bits":"7ff0000000000000","spelling":"null"}"#).unwrap(),
            Node::Num {
                bits: f64::INFINITY.to_bits(),
                spelling: "null".into()
            }
        );
        // 9007199254740993 rounds to 9007199254740992.
        let node = decode(r#"{"t":"num","bits":"4340000000000000","spelling":"9007199254740992"}"#)
            .unwrap();
        match node {
            Node::Num { bits, spelling } => {
                assert_eq!(bits, 9007199254740992f64.to_bits());
                assert_eq!(spelling, "9007199254740992");
            }
            other => panic!("want num, got {other:?}"),
        }
    }

    #[test]
    fn lone_surrogate_units_survive() {
        // U+D800 as a single unit: unrepresentable in UTF-8 or Rust String.
        assert_eq!(
            decode(r#"{"t":"text","units":[55296]}"#).unwrap(),
            Node::Text(vec![0xd800])
        );
    }

    #[test]
    fn object_order_and_proto_key_preserved() {
        let node = decode(
            r#"{"t":"obj","entries":[[[98],{"t":"num","bits":"3ff0000000000000","spelling":"1"}],[[95,95,112,114,111,116,111,95,95],{"t":"bool","v":false}]]}"#,
        )
        .unwrap();
        match node {
            Node::Obj(entries) => {
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0].0, vec![b'b' as u16]);
                assert_eq!(String::from_utf16(&entries[1].0).unwrap(), "__proto__");
                assert_eq!(entries[1].1, Node::Bool(false));
            }
            other => panic!("want obj, got {other:?}"),
        }
    }

    #[test]
    fn malformed_nodes_reject_with_codes() {
        assert_eq!(
            decode(r#"{"t":"nope"}"#).unwrap_err().code,
            transport::BAD_NODE
        );
        assert_eq!(
            decode(r#"{"t":"bool"}"#).unwrap_err().code,
            transport::BAD_NODE
        );
        assert_eq!(
            decode(r#"{"t":"num","bits":"xyz","spelling":"0"}"#)
                .unwrap_err()
                .code,
            transport::BAD_NODE
        );
        assert_eq!(decode(r#"[1,2]"#).unwrap_err().code, transport::BAD_NODE);
    }

    #[test]
    fn depth_limit_rejects_before_recursing() {
        // 200-deep nesting over the 32 node cap (and the 100 bracket cap).
        let mut json = String::from(r#"{"t":"null"}"#);
        for _ in 0..200 {
            json = format!(r#"{{"t":"arr","items":[{json}]}}"#);
        }
        assert_eq!(decode(&json).unwrap_err().code, transport::TREE_TOO_DEEP);
    }

    fn plain(text: &str) -> Result<Node, String> {
        parse_json_text(&text.encode_utf16().collect::<Vec<_>>())
    }

    #[test]
    fn plain_json_preserves_order_and_spellings() {
        let node = plain(r#"{"zebra":1.50,"alpha":-0.25,"nested":{"b":[true,null],"a":"x"}}"#).unwrap();
        match node {
            Node::Obj(entries) => {
                assert_eq!(String::from_utf16(&entries[0].0).unwrap(), "zebra");
                assert_eq!(entries[1].1, Node::Num {
                    bits: (-0.25f64).to_bits(),
                    spelling: "-0.25".into(),
                });
                match &entries[2].1 {
                    Node::Obj(inner) => {
                        assert_eq!(String::from_utf16(&inner[0].0).unwrap(), "b");
                        assert_eq!(String::from_utf16(&inner[1].0).unwrap(), "a");
                    }
                    other => panic!("want obj, got {other:?}"),
                }
            }
            other => panic!("want obj, got {other:?}"),
        }
        // Spellings stay source-exact (no float normalization).
        match plain("1.50").unwrap() {
            Node::Num { spelling, .. } => assert_eq!(spelling, "1.50"),
            other => panic!("want num, got {other:?}"),
        }
    }

    #[test]
    fn plain_json_string_escapes_and_pairs() {
        // Surrogate pair escapes stay a unit pair; lone escapes stay lone.
        assert_eq!(
            plain(r#""A𝄞""#).unwrap(),
            Node::Text(vec![0x41, 0xd834, 0xdd1e])
        );
        assert_eq!(
            plain(r#""\ud834\udd1e""#).unwrap(),
            Node::Text(vec![0xd834, 0xdd1e])
        );
        assert_eq!(
            plain(r#""\ud800""#).unwrap(),
            Node::Text(vec![0xd800])
        );
        assert_eq!(
            plain(r#""a\"b\\c\/d\be\ff\ng\rh\ti""#).unwrap(),
            Node::Text("a\"b\\c/d\x08e\x0Cf\ng\rh\ti".encode_utf16().collect::<Vec<_>>())
        );
    }

    #[test]
    fn plain_json_refusals() {
        // Duplicate keys refuse (fail-closed vs tagged wire).
        assert!(plain(r#"{"a":1,"a":2}"#).is_err());
        // Trailing content refuses.
        assert!(plain(r#"null null"#).is_err());
        assert!(plain(r#"[1,]"#).is_err());
        assert!(plain(r#"{"a"}"#).is_err());
        // Bad numbers refuse: leading zeros, bare exponents, non-finite.
        assert!(plain("01").is_err());
        assert!(plain("1e").is_err());
        assert!(plain("1e999").is_err());
        // Literal controls refuse; over-deep nesting refuses.
        assert!(plain("\"\u{1}\"").is_err());
        let mut deep = String::from("null");
        for _ in 0..40 {
            deep = format!("[{deep}]");
        }
        assert!(plain(&deep).is_err());
    }
}
