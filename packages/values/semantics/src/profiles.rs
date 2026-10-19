//! Versioned structural scaffold entry (V03.5).
//!
//! Thin binding-facing envelope over the V03.2 arena and the V03.4
//! plan registry: `{"v":1,"op":...,"args":{...}}` in, a value or a
//! staged error envelope out. The envelope never duplicates the
//! numeric transport: structural failures carry `{stage, code, check?}`
//! with stages `transport` (version/op/args/length/corrupt gates) and
//! `plan` (registry failures), and every gate runs BEFORE any arena
//! build or registration (never coerce-then-check).
//!
//! Owner tokens stay server-side: `owner.create` mints an opaque u64
//! handle bound to one [`plans::OwnerToken`], and every later op
//! resolves the handle first (forged handles fail as `foreign-owner`,
//! exactly like forged owners). Numbers cross losslessly: f64 as
//! 16-hex-digit bits, text as UTF-16 unit arrays, budgets as u32-range
//! integers. Fixed-width breaches (units element above `u16::MAX`,
//! bits longer than 16 hex digits, budgets above `u32::MAX`) reject
//! with `fixed-width/overflow` before coercion.

use std::collections::HashMap;

use num_bigint::BigInt;
use serde_json::{json, Value};

use crate::input::{Budgets, Frame, InputArena, TransportNode};
use crate::plans::{
    AliasInput, ContractInput, EnumInput, FieldInput, Meta, OperationInput, OwnerToken, PlanCode,
    PlanError, Plans, Provenance, SchemaInput, TypeBase,
};

/// Owned `values/v1` structural interpreter and whole-profile dispatch.
/// Lives under `profiles` so the shared crate assembly (`lib.rs`,
/// shared Cargo manifest) stays single-writer with the Exact lane; the
/// module is `pub` for binding-side consumers through this profile host.
#[path = "validation.rs"]
pub mod validation;

/// Structural scaffold ABI version. Requests must carry `"v": 1`.
pub const STRUCTURAL_ABI: u32 = 1;

/// One live request: its checked arena, owning plan handle and the
/// budgets its traversal runs under. Request ids are server-side u64
/// handles like owner handles: forged, stale or disposed ids fail at
/// the adapter before Rust executes.
#[derive(Debug)]
struct RequestEntry {
    arena: InputArena,
    owner: OwnerToken,
    plan_id: String,
    budgets: Budgets,
}

/// Binding-side host: one plan registry plus the handle tables that
/// keep owner tokens and live requests server-side across binding calls.
#[derive(Debug, Default)]
pub struct ProfileHost {
    plans: Plans,
    handles: HashMap<u64, OwnerToken>,
    next_handle: u64,
    requests: HashMap<u64, RequestEntry>,
    next_request: u64,
}

fn ok(value: Value) -> Value {
    json!({"ok": true, "value": value})
}

fn transport_err(code: &'static str, check: Option<&'static str>) -> Value {
    match check {
        Some(check) => json!({"ok": false, "stage": "transport", "code": code, "check": check}),
        None => json!({"ok": false, "stage": "transport", "code": code}),
    }
}

/// Open envelope containers for the iterative parser below. `Open`
/// used to live inside `parse_json_line`; it rides module scope now so
/// the iterative-destruction guards below can name it.
enum Open {
    Array(Vec<Value>),
    Key(Vec<(String, Value)>),
    Val(Vec<(String, Value)>, String),
}

/// Partial frame pieces for `parse_frame` below. Module scope for the
/// same reason as `Open`.
enum Partial {
    Value(Frame),
    Key(Vec<u16>),
}

/// Iterative destruction for one envelope-parser open stack: the `Vec`
/// nesting mirrors admitted input depth, so the default recursive
/// `Vec` drop would grow the native call stack on deep lines. The
/// guard drains explicitly; construction sites never hold a partial
/// container past one attach.
struct StackDrain(Vec<Open>);

impl Drop for StackDrain {
    fn drop(&mut self) {
        drain_opens(&mut self.0);
    }
}

/// Iterative destruction for one frame-conversion scratch stack: like
/// `StackDrain`, the `Vec` nesting mirrors admitted input depth.
/// Guards every `parse_frame` exit, including `Err` early returns.
struct PartialDrain(Vec<Partial>);

impl Drop for PartialDrain {
    fn drop(&mut self) {
        let mut pending = std::mem::take(&mut self.0);
        while let Some(partial) = pending.pop() {
            match partial {
                Partial::Value(frame) => destroy_frame(frame),
                Partial::Key(_) => {}
            }
        }
    }
}

/// Iterative `Open`-stack drain. Popping an `Open` would drop its
/// payload `Value`s recursively, so each popped container's values
/// move into the iterative `drop_value_stack` instead: a deeply
/// completed `Value` nested inside an unclosed/malformed outer
/// container unwinds on the heap, never through default `Drop`.
fn drain_opens(stack: &mut Vec<Open>) {
    let mut sink: Vec<Value> = Vec::new();
    while let Some(open) = stack.pop() {
        match open {
            Open::Array(items) => sink.extend(items),
            Open::Key(pairs) | Open::Val(pairs, _) => {
                sink.extend(pairs.into_iter().map(|(_, value)| value))
            }
        }
        let root = std::mem::replace(&mut sink, Vec::new());
        drop_value_stack(Value::Array(root));
    }
}

/// Iterative `serde_json::Value` drop: object maps and arrays unwind
/// on an explicit heap stack, so deep admitted requests never grow
/// the native call stack when a request value is released (the
/// residual that poisoned the host `RefCell` on ~12000-deep lines).
fn drop_value_stack(root: Value) {
    let mut stack = vec![root];
    while let Some(value) = stack.pop() {
        match value {
            Value::Array(items) => stack.extend(items),
            Value::Object(map) => stack.extend(map.into_iter().map(|(_, value)| value)),
            _ => {}
        }
    }
}

/// Iterative `Frame` destruction: arrays and entry tables unwind on an
/// explicit heap stack, matching `drop_value_stack` for converted
/// shapes. Thin leaves drop inline; only container nesting loops.
fn destroy_frame(root: Frame) {
    let mut stack = vec![root];
    while let Some(frame) = stack.pop() {
        match frame {
            Frame::Array(items) => stack.extend(items),
            Frame::Entries(entries) => {
                stack.extend(entries.into_iter().map(|(_, frame)| frame))
            }
            _ => {}
        }
    }
}

/// Iterative-drop wrapper for one converted request frame. Borrowck
/// needs the success value moved out without dropping through the
/// recursive `Frame` destructor, so the `Ok` arm lifts the frame out
/// of the guard and every exit path — including `Err` early returns
/// inside `parse_frame` — still unwinds through `destroy_frame`.
struct OwnedFrame(Option<Frame>);

impl OwnedFrame {
    fn lift(frame: Frame) -> Self {
        OwnedFrame(Some(frame))
    }

    fn get(&self) -> &Frame {
        self.0.as_ref().expect("frame moved out before use")
    }
}

impl Drop for OwnedFrame {
    fn drop(&mut self) {
        if let Some(frame) = self.0.take() {
            destroy_frame(frame);
        }
    }
}

/// Iterative request-envelope parser: the whole line parses on an
/// explicit heap stack, so admitted nesting is decided by the
/// caller-supplied request budgets at the arena — never by a hidden
/// envelope cap, never by parser recursion, and never by an arbitrary
/// host parser limit. Genuine syntax errors stay `args/malformed` at
/// this seam no matter how deep the line runs: depth refusals carry
/// `length/bound-exceeded` + `depth` from the budget gate that owns
/// them, and only from there.
fn parse_json_line(line: &str) -> Result<Value, ()> {
    fn skip_ws(bytes: &[u8], mut pos: usize) -> usize {
        while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t' | b'\n' | b'\r') {
            pos += 1;
        }
        pos
    }
    fn attach(stack: &mut Vec<Open>, root: &mut Option<Value>, value: Value) -> Result<(), ()> {
        match stack.pop() {
            None => {
                if root.is_some() {
                    return Err(());
                }
                *root = Some(value);
                Ok(())
            }
            Some(Open::Array(mut items)) => {
                items.push(value);
                stack.push(Open::Array(items));
                Ok(())
            }
            Some(Open::Val(mut pairs, key)) => {
                pairs.push((key, value));
                stack.push(Open::Key(pairs));
                Ok(())
            }
            Some(Open::Key(_)) => Err(()),
        }
    }
    fn container_is_fresh(top: Option<&Open>) -> bool {
        match top {
            Some(Open::Array(items)) => items.is_empty(),
            Some(Open::Key(pairs)) => pairs.is_empty(),
            _ => false,
        }
    }
    let bytes = line.as_bytes();
    let mut pos = skip_ws(bytes, 0);
    let mut stack = StackDrain(Vec::new());
    let mut root: Option<Value> = None;
    // True once a value completed at this level: the next token must
    // be a separator or a closer, never another value.
    let mut just_value = false;
    while pos < bytes.len() {
        match bytes[pos] {
            b'{' => {
                if just_value {
                    return Err(());
                }
                stack.0.push(Open::Key(Vec::new()));
                pos += 1;
            }
            b'[' => {
                if just_value {
                    return Err(());
                }
                stack.0.push(Open::Array(Vec::new()));
                pos += 1;
            }
            b'}' => {
                if !just_value && !container_is_fresh(stack.0.last()) {
                    return Err(());
                }
                match stack.0.pop() {
                    Some(Open::Key(pairs)) => {
                        attach(&mut stack.0, &mut root, Value::Object(pairs.into_iter().collect()))?;
                    }
                    _ => return Err(()),
                }
                pos += 1;
                just_value = true;
            }
            b']' => {
                if !just_value && !container_is_fresh(stack.0.last()) {
                    return Err(());
                }
                match stack.0.pop() {
                    Some(Open::Array(items)) => {
                        attach(&mut stack.0, &mut root, Value::Array(items))?;
                    }
                    _ => return Err(()),
                }
                pos += 1;
                just_value = true;
            }
            b',' => {
                if !just_value {
                    return Err(());
                }
                match stack.0.last() {
                    Some(Open::Array(_)) | Some(Open::Key(_)) => {}
                    _ => return Err(()),
                }
                pos = skip_ws(bytes, pos + 1);
                just_value = false;
                continue;
            }
            b'"' => {
                if just_value {
                    return Err(());
                }
                let (text, next) = parse_json_string(bytes, pos)?;
                pos = next;
                match stack.0.pop() {
                    Some(Open::Key(pairs)) => {
                        pos = skip_ws(bytes, pos);
                        if bytes.get(pos) != Some(&b':') {
                            return Err(());
                        }
                        pos += 1;
                        // The key's value is still required: a closer or
                        // separator here means a missing value, and the
                        // value itself parses on the next turns.
                        just_value = false;
                        stack.0.push(Open::Val(pairs, text));
                    }
                    Some(other) => {
                        stack.0.push(other);
                        attach(&mut stack.0, &mut root, Value::String(text))?;
                        just_value = true;
                    }
                    None => {
                        attach(&mut stack.0, &mut root, Value::String(text))?;
                        just_value = true;
                    }
                }
            }
            b't' => {
                if just_value {
                    return Err(());
                }
                if bytes.get(pos..pos + 4) != Some(b"true".as_slice()) {
                    return Err(());
                }
                pos += 4;
                attach(&mut stack.0, &mut root, Value::Bool(true))?;
                just_value = true;
            }
            b'f' => {
                if just_value {
                    return Err(());
                }
                if bytes.get(pos..pos + 5) != Some(b"false".as_slice()) {
                    return Err(());
                }
                pos += 5;
                attach(&mut stack.0, &mut root, Value::Bool(false))?;
                just_value = true;
            }
            b'n' => {
                if just_value {
                    return Err(());
                }
                if bytes.get(pos..pos + 4) != Some(b"null".as_slice()) {
                    return Err(());
                }
                pos += 4;
                attach(&mut stack.0, &mut root, Value::Null)?;
                just_value = true;
            }
            b'-' | b'0'..=b'9' => {
                if just_value {
                    return Err(());
                }
                let (number, next) = parse_json_number(bytes, pos)?;
                pos = next;
                attach(&mut stack.0, &mut root, Value::Number(number))?;
                just_value = true;
            }
            _ => return Err(()),
        }
        pos = skip_ws(bytes, pos);
    }
    match root {
        Some(value) if stack.0.is_empty() => Ok(value),
        _ => Err(()),
    }
}

/// Parses one JSON string starting at the opening quote: all escapes
/// including `\u` pairs, lone surrogates and raw controls refused like
/// the previous parser, so shallow verdicts are unchanged.
fn parse_json_string(bytes: &[u8], start: usize) -> Result<(String, usize), ()> {
    let mut out = String::new();
    let mut pos = start + 1;
    // Accumulate raw runs between escapes; runs are quote/backslash
    // delimited, hence code-point aligned, so `from_utf8` rejects
    // exactly the malformed sequences (including lone surrogates,
    // which UTF-8 can never encode).
    let mut run_start = pos;
    while pos < bytes.len() {
        match bytes[pos] {
            b'"' => {
                if pos > run_start {
                    out.push_str(std::str::from_utf8(&bytes[run_start..pos]).map_err(|_| ())?);
                }
                return Ok((out, pos + 1));
            }
            b'\\' => {
                if pos > run_start {
                    out.push_str(std::str::from_utf8(&bytes[run_start..pos]).map_err(|_| ())?);
                }
                pos += 1;
                if pos >= bytes.len() {
                    return Err(());
                }
                match bytes[pos] {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000C}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        pos += 1;
                        let high = parse_hex4(bytes, pos)?;
                        pos += 4;
                        if (0xD800..0xDC00).contains(&high) {
                            if bytes.get(pos..pos + 2) != Some(b"\\u".as_slice()) {
                                return Err(());
                            }
                            let low = parse_hex4(bytes, pos + 2)?;
                            pos += 6;
                            if !(0xDC00..0xE000).contains(&low) {
                                return Err(());
                            }
                            let point = 0x10000
                                + ((high as u32 - 0xD800) << 10)
                                + (low as u32 - 0xDC00);
                            out.push(char::from_u32(point).ok_or(())?);
                        } else if (0xDC00..0xE000).contains(&high) {
                            return Err(());
                        } else {
                            out.push(char::from_u32(high as u32).ok_or(())?);
                        }
                        run_start = pos;
                        continue;
                    }
                    _ => return Err(()),
                }
                pos += 1;
                run_start = pos;
            }
            byte if byte < 0x20 => return Err(()),
            _ => pos += 1,
        }
    }
    Err(())
}

fn parse_hex4(bytes: &[u8], pos: usize) -> Result<u16, ()> {
    let digits = std::str::from_utf8(bytes.get(pos..pos + 4).ok_or(())?).map_err(|_| ())?;
    u16::from_str_radix(digits, 16).map_err(|_| ())
}

/// Parses one JSON number: strict syntax (no leading zeros, fraction
/// and exponent digits required when present), integers as u64/i64
/// with a float fallback on overflow, fractions and exponents as
/// f64 — the same representation split the previous parser used for
/// every in-range input. Magnitudes past f64 range refuse as
/// malformed instead of publishing infinities.
fn parse_json_number(bytes: &[u8], start: usize) -> Result<(serde_json::Number, usize), ()> {
    let mut pos = start;
    if bytes.get(pos) == Some(&b'-') {
        pos += 1;
    }
    match bytes.get(pos) {
        Some(b'0') => pos += 1,
        Some(b'1'..=b'9') => {
            while matches!(bytes.get(pos), Some(b'0'..=b'9')) {
                pos += 1;
            }
        }
        _ => return Err(()),
    }
    let mut is_float = false;
    if bytes.get(pos) == Some(&b'.') {
        is_float = true;
        pos += 1;
        if !matches!(bytes.get(pos), Some(b'0'..=b'9')) {
            return Err(());
        }
        while matches!(bytes.get(pos), Some(b'0'..=b'9')) {
            pos += 1;
        }
    }
    if matches!(bytes.get(pos), Some(b'e') | Some(b'E')) {
        is_float = true;
        pos += 1;
        if matches!(bytes.get(pos), Some(b'+') | Some(b'-')) {
            pos += 1;
        }
        if !matches!(bytes.get(pos), Some(b'0'..=b'9')) {
            return Err(());
        }
        while matches!(bytes.get(pos), Some(b'0'..=b'9')) {
            pos += 1;
        }
    }
    let text = std::str::from_utf8(&bytes[start..pos]).map_err(|_| ())?;
    if !is_float {
        // Negative zero parses as the float `-0.0`, like the previous
        // parser: `-0` keeps its sign bit through the seam.
        if text.starts_with('-') && text[1..].bytes().all(|byte| byte == b'0') {
            if let Some(zero) = serde_json::Number::from_f64(-0.0) {
                return Ok((zero, pos));
            }
        }
        if let Ok(int) = text.parse::<u64>() {
            return Ok((serde_json::Number::from(int), pos));
        }
        if let Ok(int) = text.parse::<i64>() {
            return Ok((serde_json::Number::from(int), pos));
        }
    }
    match text.parse::<f64>() {
        Ok(float) => serde_json::Number::from_f64(float).map(|number| (number, pos)).ok_or(()),
        Err(_) => Err(()),
    }
}

fn plan_err(error: &PlanError) -> Value {
    json!({"ok": false, "stage": "plan", "code": error.code.as_str()})
}

fn u32_arg(value: Option<&Value>) -> Result<u32, Value> {
    match value.and_then(Value::as_u64) {
        Some(n) if n <= u32::MAX as u64 => Ok(n as u32),
        Some(_) => Err(transport_err("fixed-width/overflow", None)),
        None => Err(transport_err("args/malformed", None)),
    }
}

fn str_arg(value: Option<&Value>) -> Result<&str, Value> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))
}

fn parse_bits(hex: &str) -> Result<u64, Value> {
    if hex.len() > 16 {
        return Err(transport_err("fixed-width/overflow", None));
    }
    u64::from_str_radix(hex, 16).map_err(|_| transport_err("args/malformed", None))
}

fn parse_units(value: &Value) -> Result<Vec<u16>, Value> {
    let items = value
        .as_array()
        .ok_or_else(|| transport_err("args/malformed", None))?;
    let mut units = Vec::with_capacity(items.len());
    for item in items {
        match item.as_u64() {
            Some(n) if n <= u16::MAX as u64 => units.push(n as u16),
            Some(_) => return Err(transport_err("fixed-width/overflow", None)),
            None => return Err(transport_err("args/malformed", None)),
        }
    }
    Ok(units)
}

/// Builds a host frame from its tagged JSON form, iteratively over
/// an explicit heap stack: admitted nesting is bounded by the
/// request budgets at the arena, so frame parsing itself imposes no
/// recursion cap and grows no native stack. Every numeric conversion
/// is checked: malformed shapes reject, fixed-width breaches
/// overflow, and nothing parses through lossy floats.
fn parse_frame(root: &Value) -> Result<OwnedFrame, Value> {
    enum Work<'a> {
        Visit(&'a Value),
        Key(&'a Value),
        CloseArray(usize),
        CloseEntries(usize),
    }
    let malformed = || transport_err("args/malformed", None);
    let mut work = vec![Work::Visit(root)];
    let mut out = PartialDrain(Vec::new());
    while let Some(job) = work.pop() {
        match job {
            Work::CloseArray(len) => {
                if out.0.len() < len {
                    return Err(malformed());
                }
                let mut items = Vec::with_capacity(len);
                for _ in 0..len {
                    match out.0.pop() {
                        Some(Partial::Value(frame)) => items.push(frame),
                        _ => return Err(malformed()),
                    }
                }
                items.reverse();
                out.0.push(Partial::Value(Frame::Array(items)));
            }
            Work::CloseEntries(len) => {
                // Pairs iterate in reverse but each pair's key lands
                // after its value, so the top pops as (key, value) in
                // input order: no re-reversal.
                if out.0.len() < 2 * len {
                    return Err(malformed());
                }
                let mut entries = Vec::with_capacity(len);
                for _ in 0..len {
                    match (out.0.pop(), out.0.pop()) {
                        (Some(Partial::Key(key)), Some(Partial::Value(frame))) => {
                            entries.push((key, frame))
                        }
                        _ => return Err(malformed()),
                    }
                }
                // Pops arrive last-pair-first (LIFO work stack), so
                // restore input order exactly like the array arm: entry
                // order is first-insertion order downstream (duplicate
                // keys, violation order, normalized output).
                entries.reverse();
                out.0.push(Partial::Value(Frame::Entries(entries)));
            }
            Work::Key(node) => {
                let units = node.as_array().ok_or_else(malformed)?;
                let mut key = Vec::with_capacity(units.len());
                for unit in units {
                    match unit.as_u64() {
                        Some(unit) if unit <= u16::MAX as u64 => key.push(unit as u16),
                        Some(_) => return Err(transport_err("fixed-width/overflow", None)),
                        None => return Err(malformed()),
                    }
                }
                out.0.push(Partial::Key(key));
            }
            Work::Visit(node) => {
                let tag = node
                    .get("t")
                    .and_then(Value::as_str)
                    .ok_or_else(malformed)?;
                match tag {
                    "f64" => {
                        let bits = parse_bits(str_arg(node.get("bits"))?)?;
                        out.0.push(Partial::Value(Frame::F64Bits(bits)));
                    }
                    "text" => out.0.push(Partial::Value(Frame::TextUnits(parse_units(
                        node
                            .get("units")
                            .ok_or_else(malformed)?,
                    )?))),
                    "bool" => {
                        let flag = node.get("v").and_then(Value::as_bool).ok_or_else(malformed)?;
                        out.0.push(Partial::Value(Frame::Bool(flag)));
                    }
                    "null" => out.0.push(Partial::Value(Frame::OwnNull)),
                    "missing" => out.0.push(Partial::Value(Frame::Missing)),
                    "array" => {
                        let items = node.get("items").and_then(Value::as_array).ok_or_else(malformed)?;
                        work.push(Work::CloseArray(items.len()));
                        for item in items.iter().rev() {
                            work.push(Work::Visit(item));
                        }
                    }
                    "entries" => {
                        let items =
                            node.get("entries").and_then(Value::as_array).ok_or_else(malformed)?;
                        work.push(Work::CloseEntries(items.len()));
                        for item in items.iter().rev() {
                            let pair = item.as_array().ok_or_else(malformed)?;
                            if pair.len() != 2 {
                                return Err(malformed());
                            }
                            work.push(Work::Key(&pair[0]));
                            work.push(Work::Visit(&pair[1]));
                        }
                    }
                    _ => return Err(malformed()),
                }
            }
        }
    }
    match (out.0.pop(), out.0.is_empty()) {
        (Some(Partial::Value(frame)), true) => Ok(OwnedFrame::lift(frame)),
        _ => Err(malformed()),
    }
}

fn hex16(bits: u64) -> String {
    format!("{bits:016x}")
}

/// Cap on admitted resolved entries per execution: the host loop
/// appends one entry per deferred leaf, so legitimate joins stay far
/// below this; anything larger fails closed as malformed args.
const MAX_RESOLVED_ENTRIES: usize = 1024;

/// Parses one resolved value-path segment in violation encoding:
/// `{"k": [...]}` for object keys (lossless units) or `{"i": n}`
/// for array indices.
fn parse_resolved_seg(value: &Value) -> Result<validation::PathSeg, Value> {
    let fields = value
        .as_object()
        .ok_or_else(|| transport_err("args/malformed", None))?;
    if let Some(key) = fields.get("k") {
        return Ok(validation::PathSeg::Key(parse_units(key)?));
    }
    if let Some(index) = fields.get("i") {
        let position = index
            .as_u64()
            .ok_or_else(|| transport_err("args/malformed", None))?;
        let at: usize = position
            .try_into()
            .map_err(|_| transport_err("args/malformed", None))?;
        return Ok(validation::PathSeg::Index(at));
    }
    Err(transport_err("args/malformed", None))
}

/// Parses one resolved value path in violation segment encoding.
fn parse_resolved_path(value: &Value) -> Result<Vec<validation::PathSeg>, Value> {
    let items = value
        .as_array()
        .ok_or_else(|| transport_err("args/malformed", None))?;
    items.iter().map(parse_resolved_seg).collect()
}

/// Parses one host-replayed exact-codec violation: leaf-relative path
/// plus the genuine codec code and message. Native prefixes the leaf
/// path and preserves order at consumption.
fn parse_host_violation(value: &Value) -> Result<validation::Violation, Value> {
    let path = parse_resolved_path(
        value
            .get("path")
            .ok_or_else(|| transport_err("args/malformed", None))?,
    )?;
    let code = str_arg(value.get("code"))?.to_string();
    let message = str_arg(value.get("message"))?.to_string();
    if code.is_empty() || message.is_empty() {
        return Err(transport_err("args/malformed", None));
    }
    let optional = |key: &str| -> Result<Option<String>, Value> {
        match value.get(key) {
            None => Ok(None),
            Some(item) => Ok(Some(str_arg(Some(item))?.to_string())),
        }
    };
    Ok(validation::Violation::replayed(
        path,
        code,
        message,
        optional("expected")?,
        optional("actual")?,
    ))
}

/// One structurally parsed resolved entry: the value path plus
/// exactly one of a canonical frame or replayed violations.
struct ParsedEntry {
    path: Vec<validation::PathSeg>,
    frame: Option<Value>,
    violations: Vec<validation::Violation>,
}

/// Parses the optional `resolved` argument: an array of entries each
/// carrying a value path plus exactly one of `frame` (canonical value
/// frame from a genuine host decode) or `violations` (non-empty
/// replay list from a failed decode). Absent or null admits nothing:
/// coverage and execution then behave exactly as before. Duplicate
/// paths fail closed.
fn parse_resolved(args: &Value) -> Result<Vec<ParsedEntry>, Value> {
    let raw = match args.get("resolved") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(value) => value,
    };
    let items = raw
        .as_array()
        .ok_or_else(|| transport_err("args/malformed", None))?;
    if items.len() > MAX_RESOLVED_ENTRIES {
        return Err(transport_err("args/malformed", None));
    }
    let mut out = Vec::with_capacity(items.len());
    let mut seen: HashMap<Vec<validation::PathSeg>, ()> = HashMap::new();
    for item in items {
        if !item.is_object() {
            return Err(transport_err("args/malformed", None));
        }
        let path = parse_resolved_path(
            item.get("path")
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )?;
        if seen.insert(path.clone(), ()).is_some() {
            return Err(transport_err("args/malformed", None));
        }
        let frame = match item.get("frame") {
            None | Some(Value::Null) => None,
            Some(frame) => {
                if !frame.is_object() {
                    return Err(transport_err("args/malformed", None));
                }
                Some(frame.clone())
            }
        };
        let violations = match item.get("violations") {
            None | Some(Value::Null) => Vec::new(),
            Some(list) => {
                let records = list
                    .as_array()
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                if records.is_empty() {
                    return Err(transport_err("args/malformed", None));
                }
                let mut replayed = Vec::with_capacity(records.len());
                for record in records {
                    replayed.push(parse_host_violation(record)?);
                }
                replayed
            }
        };
        match (&frame, violations.is_empty()) {
            (Some(_), true) | (None, _) => {}
            _ => return Err(transport_err("args/malformed", None)),
        }
        out.push(ParsedEntry {
            path,
            frame,
            violations,
        });
    }
    Ok(out)
}

/// Coarse canonical-shape check for one entry frame: money rides
/// entries, every other exact scalar rides text, arrays nest the
/// scalar shape. Canonicality itself is the host decode's genuine
/// verdict; this only refuses skew between the entry and the leaf.
fn resolved_shape(kind: &str, array: bool, frame: &Frame) -> bool {
    match frame {
        Frame::Array(items) => array && items.iter().all(|item| resolved_shape(kind, false, item)),
        Frame::TextUnits(_) => !array && kind != "money",
        Frame::Entries(_) => !array && kind == "money",
        _ => false,
    }
}

/// Admits structurally parsed entries against the target: every path
/// must name a directly resolvable exact leaf, value and violation
/// entries require the leaf present in the arena (markers decide
/// natively), and value frames pass the request budgets plus the
/// shape check. Anything else fails closed with the existing voices.
fn admit_resolved(
    arena: &InputArena,
    plan: &crate::plans::Plan,
    target: &validation::Target,
    budgets: &Budgets,
    entries: Vec<ParsedEntry>,
) -> Result<validation::ResolvedMap, Value> {
    let mut admitted = validation::ResolvedMap::new();
    for entry in entries {
        let (kind, array) = match validation::exact_leaf_at(plan, target, &entry.path) {
            Some(leaf) => leaf,
            None => return Err(transport_err("args/malformed", None)),
        };
        let present = validation::resolve_vpath(arena, &entry.path).is_some();
        match (entry.frame, entry.violations.is_empty()) {
            // Native-decides marker for absent/null inputs: coverage
            // counts the path, execution applies the unchanged duties.
            (None, true) => {
                admitted.insert(
                    entry.path,
                    validation::ResolvedLeaf {
                        frame: None,
                        violations: Vec::new(),
                        nodes: 0,
                        depth: 0,
                    },
                );
            }
            // Replayed decode failure: the leaf input exists, the
            // genuine codec refused it, native replays in order.
            (None, false) => {
                if !present {
                    return Err(transport_err("args/malformed", None));
                }
                admitted.insert(
                    entry.path,
                    validation::ResolvedLeaf {
                        frame: None,
                        violations: entry.violations,
                        nodes: 0,
                        depth: 0,
                    },
                );
            }
            // Canonical value: the leaf input exists, the frame fits
            // the request budgets and the leaf shape.
            (Some(frame_json), true) => {
                if !present {
                    return Err(transport_err("args/malformed", None));
                }
                let frame = parse_frame(&frame_json)?;
                let built = match InputArena::build(frame.get(), budgets) {
                    Ok(arena) => arena,
                    Err(error) => return Err(transport_err(error.code, error.check)),
                };
                if !resolved_shape(&kind, array, frame.get()) {
                    return Err(transport_err("args/malformed", None));
                }
                admitted.insert(
                    entry.path,
                    validation::ResolvedLeaf {
                        frame: Some(frame_json),
                        violations: Vec::new(),
                        nodes: built.len(),
                        depth: validation::frame_depth(frame.get()),
                    },
                );
            }
            _ => return Err(transport_err("args/malformed", None)),
        }
    }
    Ok(admitted)
}

/// Echoes one built node as identifying data: bits for f64, units for
/// text, ordered keys for entries, length for arrays, tag otherwise.
/// The echo proves preservation without re-rendering values.
fn digest_node(arena: &InputArena, index: usize) -> Value {
    match arena.node(index) {
        TransportNode::F64 { bits } => json!({"tag": "f64", "bits": hex16(*bits)}),
        TransportNode::Text { units } => json!({"tag": "text", "units": units}),
        TransportNode::Bool(flag) => json!({"tag": "bool", "v": flag}),
        TransportNode::OwnNull => json!({"tag": "own-null"}),
        TransportNode::Missing => json!({"tag": "missing"}),
        TransportNode::Array { items } => json!({"tag": "array", "len": items.len()}),
        TransportNode::Entries { entries } => {
            let keys: Vec<&Vec<u16>> = entries.iter().map(|e| &e.key).collect();
            json!({"tag": "entries", "keys": keys})
        }
        TransportNode::Tagged { .. } => json!({"tag": "tagged"}),
    }
}

/// Maximum default/bound metadata nesting accepted at registration
/// (mirrors the interpreter's conversion cap; deeper owner metadata is
/// malformed, never an unbounded conversion).
const MAX_META_DEPTH: usize = 128;

fn parse_meta(value: &Value, depth: usize) -> Result<Meta, Value> {
    if depth > MAX_META_DEPTH {
        return Err(plan_err(&PlanError {
            code: PlanCode::MalformedSchema,
            message: "default metadata is too deeply nested".to_string(),
        }));
    }
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    match tag {
        "null" => Ok(Meta::Null),
        "bool" => Ok(Meta::Bool(
            value
                .get("v")
                .and_then(Value::as_bool)
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )),
        "bits" => Ok(Meta::NumBits(parse_bits(str_arg(value.get("bits"))?)?)),
        "text" => Ok(Meta::Text(parse_units(
            value
                .get("units")
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )?)),
        "bigint" => {
            let digits = str_arg(value.get("digits"))?;
            BigInt::parse_bytes(digits.as_bytes(), 10)
                .map(Meta::Bigint)
                .ok_or_else(|| transport_err("args/malformed", None))
        }
        "array" => {
            let items = value
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(parse_meta(item, depth + 1)?);
            }
            Ok(Meta::Array(out))
        }
        "object" => {
            let items = value
                .get("entries")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let pair = item
                    .as_array()
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                if pair.len() != 2 {
                    return Err(transport_err("args/malformed", None));
                }
                out.push((
                    str_arg(Some(&pair[0]))?.to_string(),
                    parse_meta(&pair[1], depth + 1)?,
                ));
            }
            Ok(Meta::Object(out))
        }
        "undef" => Ok(Meta::Undefined),
        _ => Err(transport_err("args/malformed", None)),
    }
}

fn opt_meta(value: &Value, key: &str) -> Result<Option<Meta>, Value> {
    match value.get(key) {
        None => Ok(None),
        Some(item) => parse_meta(item, 0).map(Some),
    }
}

fn opt_f64(value: &Value, key: &str) -> Result<Option<f64>, Value> {
    match value.get(key) {
        None => Ok(None),
        Some(item) => item
            .as_f64()
            .map(Some)
            .ok_or_else(|| transport_err("args/malformed", None)),
    }
}

fn opt_bool(value: &Value, key: &str) -> Result<Option<bool>, Value> {
    match value.get(key) {
        None => Ok(None),
        Some(item) => item
            .as_bool()
            .map(Some)
            .ok_or_else(|| transport_err("args/malformed", None)),
    }
}

fn parse_base(value: &Value) -> Result<TypeBase, Value> {
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    match tag {
        "scalar" => Ok(TypeBase::Scalar {
            name: str_arg(value.get("name"))?.to_string(),
        }),
        "stringlike" => Ok(TypeBase::Stringlike {
            name: str_arg(value.get("name"))?.to_string(),
        }),
        "user" => Ok(TypeBase::User),
        "member" => Ok(TypeBase::Member),
        "file" => Ok(TypeBase::File),
        "secret" => Ok(TypeBase::Secret),
        "json" => Ok(TypeBase::Json),
        "nominal" => Ok(TypeBase::Nominal {
            path: str_arg(value.get("path"))?.to_string(),
        }),
        "action" | "invocation" => {
            let targets = match value.get("targets") {
                None => None,
                Some(items) => {
                    let list = items
                        .as_array()
                        .ok_or_else(|| transport_err("args/malformed", None))?;
                    let mut out = Vec::with_capacity(list.len());
                    for item in list {
                        out.push(str_arg(Some(item))?.to_string());
                    }
                    Some(out)
                }
            };
            if tag == "action" {
                Ok(TypeBase::Action { targets })
            } else {
                Ok(TypeBase::Invocation { targets })
            }
        }
        "delivery" => {
            let operation = match value.get("operation") {
                None => None,
                Some(item) => Some(str_arg(Some(item))?.to_string()),
            };
            Ok(TypeBase::Delivery { operation })
        }
        "enum" => {
            let list = value
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut cases = Vec::with_capacity(list.len());
            for item in list {
                cases.push(str_arg(Some(item))?.to_string());
            }
            Ok(TypeBase::Enum { cases })
        }
        "union" => {
            let list = value
                .get("arms")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut arms = Vec::with_capacity(list.len());
            for item in list {
                arms.push(str_arg(Some(item))?.to_string());
            }
            Ok(TypeBase::Union { arms })
        }
        _ => Err(transport_err("args/malformed", None)),
    }
}

/// Parses one carried `excludedIds` entry as lossless UTF-16 units.
/// Names crossing as JSON text stay exact for well-formed text; the
/// id check itself runs over units, never lossy strings.
fn parse_excluded_ids(value: &Value) -> Result<Vec<Vec<u16>>, Value> {
    let mut out = Vec::new();
    for key in ["excludedIds", "excluded_ids"] {
        if let Some(list) = value.get(key) {
            let items = list
                .as_array()
                .ok_or_else(|| transport_err("args/malformed", None))?;
            for item in items {
                out.push(parse_units(item)?);
            }
        }
    }
    Ok(out)
}

fn parse_field(value: &Value) -> Result<FieldInput, Value> {
    let flag =
        |key: &str| Ok::<bool, Value>(value.get(key).and_then(Value::as_bool).unwrap_or(false));
    // Carried duties (never silently dropped): `format` only "name",
    // `distinctBy` only "id"; deeper shape gates run in `check_schema`.
    let format = match value.get("format") {
        None => None,
        Some(item) => Some(str_arg(Some(item))?.to_string()),
    };
    let mut distinct_by = flag("distinct_by")?;
    if let Some(raw) = value.get("distinctBy") {
        let text = str_arg(Some(raw))?;
        if text != "id" {
            return Err(plan_err(&PlanError {
                code: PlanCode::MalformedSchema,
                message: "distinctBy must be \"id\"".to_string(),
            }));
        }
        distinct_by = true;
    }
    Ok(FieldInput {
        name: str_arg(value.get("name"))?.to_string(),
        type_id: str_arg(value.get("type_id"))?.to_string(),
        base: parse_base(
            value
                .get("base")
                .ok_or_else(|| transport_err("args/malformed", None))?,
        )?,
        array: flag("array")?,
        nullable: flag("nullable")?,
        required_array: flag("required_array")?,
        required: flag("required")?,
        has_default: flag("has_default")?,
        default: opt_meta(value, "default")?,
        length_min: opt_f64(value, "length_min")?,
        length_max: opt_f64(value, "length_max")?,
        value_min: opt_meta(value, "value_min")?,
        value_max: opt_meta(value, "value_max")?,
        trim: opt_bool(value, "trim")?,
        server_only: flag("server_only")?,
        default_origin: match value.get("default_origin") {
            None => None,
            Some(item) => Some(str_arg(Some(item))?.to_string()),
        },
        format,
        distinct_by,
        excluded_ids: parse_excluded_ids(value)?,
    })
}

/// Parses one carried text alias: bounded text with NAME format (`type`
/// must be `"text"`, `format` must be `"name"`; only bounds are stored).
fn parse_alias(value: &Value) -> Result<AliasInput, Value> {
    if str_arg(value.get("type"))? != "text" || str_arg(value.get("format"))? != "name" {
        return Err(plan_err(&PlanError {
            code: PlanCode::MalformedSchema,
            message: "text aliases require bounded text with NAME format".to_string(),
        }));
    }
    let min = value
        .get("min")
        .and_then(Value::as_f64)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    let max = value
        .get("max")
        .and_then(Value::as_f64)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    Ok(AliasInput {
        name: str_arg(value.get("name"))?.to_string(),
        length_min: min,
        length_max: max,
    })
}

fn parse_schema(value: &Value) -> Result<SchemaInput, Value> {
    let tag = value
        .get("t")
        .and_then(Value::as_str)
        .ok_or_else(|| transport_err("args/malformed", None))?;
    match tag {
        "legacy" => Ok(SchemaInput::LegacyWrapper(
            str_arg(value.get("text"))?.to_string(),
        )),
        "normalized" => {
            let raw_aliases = match value.get("aliases") {
                None => Vec::new(),
                Some(list) => list
                    .as_array()
                    .ok_or_else(|| transport_err("args/malformed", None))?
                    .clone(),
            };
            let mut aliases = Vec::with_capacity(raw_aliases.len());
            for alias in &raw_aliases {
                aliases.push(parse_alias(alias)?);
            }
            let contracts = value
                .get("contracts")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out_contracts = Vec::with_capacity(contracts.len());
            for contract in contracts {
                let fields = contract
                    .get("fields")
                    .and_then(Value::as_array)
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                let mut out_fields = Vec::with_capacity(fields.len());
                for field in fields {
                    out_fields.push(parse_field(field)?);
                }
                out_contracts.push(ContractInput {
                    name: str_arg(contract.get("name"))?.to_string(),
                    fields: out_fields,
                });
            }
            let enums = value
                .get("enums")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out_enums = Vec::with_capacity(enums.len());
            for enum_def in enums {
                let cases = enum_def
                    .get("cases")
                    .and_then(Value::as_array)
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                let mut out_cases = Vec::with_capacity(cases.len());
                for case in cases {
                    out_cases.push(str_arg(Some(case))?.to_string());
                }
                out_enums.push(EnumInput {
                    name: str_arg(enum_def.get("name"))?.to_string(),
                    cases: out_cases,
                });
            }
            let operations = value
                .get("operations")
                .and_then(Value::as_array)
                .ok_or_else(|| transport_err("args/malformed", None))?;
            let mut out_operations = Vec::with_capacity(operations.len());
            for operation in operations {
                let inputs = operation
                    .get("inputs")
                    .and_then(Value::as_array)
                    .ok_or_else(|| transport_err("args/malformed", None))?;
                let mut out_inputs = Vec::with_capacity(inputs.len());
                for input in inputs {
                    out_inputs.push(parse_field(input)?);
                }
                out_operations.push(OperationInput {
                    name: str_arg(operation.get("name"))?.to_string(),
                    inputs: out_inputs,
                    mutation: operation
                        .get("mutation")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
            Ok(SchemaInput::Normalized {
                contracts: out_contracts,
                enums: out_enums,
                operations: out_operations,
                aliases,
            })
        }
        _ => Err(transport_err("args/malformed", None)),
    }
}

impl ProfileHost {
    fn owner_of(&self, args: &Value) -> Result<OwnerToken, Value> {
        let handle = args
            .get("owner")
            .and_then(Value::as_u64)
            .ok_or_else(|| transport_err("args/malformed", None))?;
        self.handles
            .get(&handle)
            .copied()
            .ok_or_else(|| json!({"ok": false, "stage": "plan", "code": "foreign-owner"}))
    }

    fn op_input_digest(&self, args: &Value) -> Value {
        let frame = match args
            .get("frame")
            .ok_or_else(|| transport_err("args/malformed", None))
            .and_then(parse_frame)
        {
            Ok(frame) => frame,
            Err(response) => return response,
        };
        let budgets_value = args
            .get("budgets")
            .ok_or_else(|| transport_err("args/malformed", None));
        let budgets_value = match budgets_value {
            Ok(value) => value,
            Err(response) => return response,
        };
        let nodes = match u32_arg(budgets_value.get("nodes")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let depth = match u32_arg(budgets_value.get("depth")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let text = match u32_arg(budgets_value.get("text")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let entries = match u32_arg(budgets_value.get("entries")) {
            Ok(n) => n,
            Err(response) => return response,
        };
        let budgets = Budgets {
            max_nodes: nodes as usize,
            max_depth: depth as usize,
            max_text_units: text as usize,
            max_entries: entries as usize,
        };
        match InputArena::build(frame.get(), &budgets) {
            Ok(arena) => {
                let root = arena.root();
                ok(json!({"nodes": arena.len(), "root": digest_node(&arena, root)}))
            }
            Err(error) => transport_err(error.code, error.check),
        }
    }

    fn op_owner_create(&mut self, args: &Value) -> Value {
        let get = |key: &str| str_arg(args.get(key));
        let (abi, profile, backend, owner_rev) =
            match (get("abi"), get("profile"), get("backend"), get("owner_rev")) {
                (Ok(abi), Ok(profile), Ok(backend), Ok(owner_rev)) => {
                    (abi, profile, backend, owner_rev)
                }
                _ => return transport_err("args/malformed", None),
            };
        let bound = match u32_arg(args.get("bound")) {
            Ok(bound) => bound,
            Err(response) => return response,
        };
        let scope = crate::plans::OwnerScope {
            abi: abi.to_string(),
            profile: profile.to_string(),
            backend: backend.to_string(),
            owner_rev: owner_rev.to_string(),
        };
        match self.plans.create_owner(scope, bound as usize) {
            Ok(token) => {
                let handle = self.next_handle;
                self.next_handle += 1;
                self.handles.insert(handle, token);
                ok(json!({"owner": handle}))
            }
            Err(error) => plan_err(&error),
        }
    }

    fn op_plan_register(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let profile = match str_arg(args.get("profile")) {
            Ok(profile) => profile,
            Err(response) => return response,
        };
        let schema = match args
            .get("schema")
            .ok_or_else(|| transport_err("args/malformed", None))
            .and_then(parse_schema)
        {
            Ok(schema) => schema,
            Err(response) => return response,
        };
        let provenance = match args.get("provenance") {
            None => None,
            Some(item) => {
                let factory = match str_arg(item.get("factory")) {
                    Ok(factory) => factory,
                    Err(response) => return response,
                };
                let owner_rev = match str_arg(item.get("owner_rev")) {
                    Ok(owner_rev) => owner_rev,
                    Err(response) => return response,
                };
                Some(Provenance {
                    factory: factory.to_string(),
                    owner_rev: owner_rev.to_string(),
                })
            }
        };
        match self
            .plans
            .register(&owner, profile, &schema, provenance.as_ref())
        {
            Ok(id) => ok(json!({"id": id})),
            Err(error) => plan_err(&error),
        }
    }

    fn op_plan_get(&self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let id = match str_arg(args.get("id")) {
            Ok(id) => id,
            Err(response) => return response,
        };
        match self.plans.get(&owner, id) {
            Ok(plan) => ok(json!({
                "id": plan.id,
                "profile": plan.profile,
                "generation": plan.generation,
                "sequence": plan.sequence,
                "contracts": plan.contract_order,
                "enums": plan.enum_order,
                "operations": plan.operation_order,
                "aliases": plan.alias_order,
                "dispatch": plan.dispatch.iter().map(|(path, arms)| json!({"path": path, "arms": arms})).collect::<Vec<_>>(),
            })),
            Err(error) => plan_err(&error),
        }
    }

    fn op_plan_release(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let id = match str_arg(args.get("id")) {
            Ok(id) => id,
            Err(response) => return response,
        };
        self.plans.release(&owner, id);
        ok(Value::Null)
    }

    fn op_owner_retire(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        match self.plans.retire_generation(&owner) {
            Ok(generation) => ok(json!({"generation": generation})),
            Err(error) => plan_err(&error),
        }
    }

    /// Parses shared traversal budgets: explicit caller inputs, never
    /// defaults that could change the owned contract.
    fn parse_budgets(args: &Value) -> Result<Budgets, Value> {
        let budgets = args
            .get("budgets")
            .ok_or_else(|| transport_err("args/malformed", None))?;
        Ok(Budgets {
            max_nodes: u32_arg(budgets.get("nodes"))? as usize,
            max_depth: u32_arg(budgets.get("depth"))? as usize,
            max_text_units: u32_arg(budgets.get("text"))? as usize,
            max_entries: u32_arg(budgets.get("entries"))? as usize,
        })
    }

    /// Begins one owned request: gates owner and plan handles, builds
    /// the checked arena, and retains it server-side under a fresh
    /// request id. Parser-token creation records ownership without
    /// traversal; conversion starts here, at the validation point.
    fn op_request_begin(&mut self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let plan_id = match str_arg(args.get("plan")) {
            Ok(plan_id) => plan_id.to_string(),
            Err(response) => return response,
        };
        if self.plans.get(&owner, &plan_id).is_err() {
            // Unknown, released or retired-generation handles fail here,
            // before any arena is built or retained.
            let error = self
                .plans
                .get(&owner, &plan_id)
                .expect_err("checked above");
            return plan_err(&error);
        }
        let frame = match args
            .get("frame")
            .ok_or_else(|| transport_err("args/malformed", None))
            .and_then(parse_frame)
        {
            Ok(frame) => frame,
            Err(response) => return response,
        };
        let budgets = match Self::parse_budgets(args) {
            Ok(budgets) => budgets,
            Err(response) => return response,
        };
        match InputArena::build(frame.get(), &budgets) {
            Ok(arena) => {
                let id = self.next_request;
                self.next_request += 1;
                self.requests.insert(
                    id,
                    RequestEntry {
                        arena,
                        owner,
                        plan_id,
                        budgets,
                    },
                );
                ok(json!({"request": id}))
            }
            Err(error) => transport_err(error.code, error.check),
        }
    }

    /// Parses one whole-profile execution target.
    fn parse_target(args: &Value) -> Result<validation::Target, Value> {
        let target = args
            .get("target")
            .ok_or_else(|| transport_err("args/malformed", None))?;
        match target.get("kind").and_then(Value::as_str) {
            Some("contract") => {
                let name = str_arg(target.get("name"))?.to_string();
                let mode = match target.get("mode").and_then(Value::as_str) {
                    Some("create") => validation::Mode::Create,
                    Some("update") => validation::Mode::Update,
                    _ => return Err(transport_err("args/malformed", None)),
                };
                Ok(validation::Target::Contract { name, mode })
            }
            Some("operation") => Ok(validation::Target::Operation {
                name: str_arg(target.get("name"))?.to_string(),
            }),
            _ => Err(transport_err("args/malformed", None)),
        }
    }

    /// Reports the registration-time coverage selection for one
    /// plan target, before any request begins: fully covered targets
    /// select native execution outright; targets reaching a directly
    /// resolvable exact leaf select native execution through the host
    /// resolve join; every other gap (carrier, host-predicate or
    /// union-nested leaves) selects the explicit TS-only path. The
    /// installer records this selection per operation; runtime
    /// deferrals never silently re-decide it.
    fn op_values_coverage(&self, args: &Value) -> Value {
        let owner = match self.owner_of(args) {
            Ok(owner) => owner,
            Err(response) => return response,
        };
        let plan_id = match str_arg(args.get("plan")) {
            Ok(plan_id) => plan_id.to_string(),
            Err(response) => return response,
        };
        let plan = match self.plans.get(&owner, &plan_id) {
            Ok(plan) => plan.clone(),
            Err(error) => return plan_err(&error),
        };
        let profile = match str_arg(args.get("profile")) {
            Ok(profile) => profile,
            Err(response) => return response,
        };
        if profile != plan.profile {
            return plan_err(&PlanError {
                code: PlanCode::InvalidProfile,
                message: "execution profile does not match the registered plan profile".to_string(),
            });
        }
        let target = match Self::parse_target(args) {
            Ok(target) => target,
            Err(response) => return response,
        };
        let resolve = |key: &str| {
            self.plans
                .resolve_default(
                    &owner,
                    &crate::plans::DefaultRef {
                        key: key.to_string(),
                    },
                )
                .ok()
                .cloned()
        };
        let empty: std::collections::HashSet<Vec<validation::PathSeg>> =
            std::collections::HashSet::new();
        match validation::target_gap(&plan, &target, &resolve, &empty) {
            None => ok(json!({"covered": true})),
            Some(gap) => {
                let mut value = json!({
                    "covered": false,
                    "reason": gap.owner.reason(),
                    "detail": format!(
                        "target reaches a leaf owned by {} at {}",
                        gap.owner.reason(),
                        gap.plan
                    ),
                });
                if let Some(pointer) = gap.pointer {
                    value["leaf"] = Value::String(pointer.leaf);
                    value["path"] = Value::Array(
                        pointer
                            .path
                            .iter()
                            .map(|segment| match segment {
                                validation::PathSeg::Key(units) => json!({"k": units}),
                                validation::PathSeg::Index(index) => json!({"i": index}),
                            })
                            .collect(),
                    );
                    value["array"] = Value::Bool(pointer.array);
                }
                ok(value)
            }
        }
    }

    /// Executes one whole profile action against a live request: the
    /// plan resolves fresh (retirement between begin and execute fails
    /// closed), coverage defers before traversal, and failures never
    /// publish partial values. No semantic operation is retried here.
    fn op_values_execute(&mut self, args: &Value) -> Value {
        let request = match args.get("request").and_then(Value::as_u64) {
            Some(request) => request,
            None => return transport_err("args/malformed", None),
        };
        let profile = match str_arg(args.get("profile")) {
            Ok(profile) => profile,
            Err(response) => return response,
        };
        let target = match Self::parse_target(args) {
            Ok(target) => target,
            Err(response) => return response,
        };
        let entry = match self.requests.get(&request) {
            Some(entry) => entry,
            // Forged, stale or disposed handles fail at the adapter,
            // before Rust executes.
            None => return transport_err("request/unknown", None),
        };
        let plan = match self.plans.get(&entry.owner, &entry.plan_id) {
            Ok(plan) => plan.clone(),
            Err(error) => return plan_err(&error),
        };
        if profile != plan.profile {
            return plan_err(&PlanError {
                code: PlanCode::InvalidProfile,
                message: "execution profile does not match the registered plan profile".to_string(),
            });
        }
        let known = match &target {
            validation::Target::Contract { name, .. } => {
                plan.contracts.iter().any(|contract| contract.name == *name)
            }
            validation::Target::Operation { name } => plan
                .operations
                .iter()
                .any(|operation| operation.name == *name),
        };
        if !known {
            return plan_err(&PlanError {
                code: PlanCode::UnknownTarget,
                message: "execution target names no declared contract or operation".to_string(),
            });
        }
        let resolve = |key: &str| {
            self.plans
                .resolve_default(
                    &entry.owner,
                    &crate::plans::DefaultRef {
                        key: key.to_string(),
                    },
                )
                .ok()
                .cloned()
        };
        let parsed = match parse_resolved(args) {
            Ok(entries) => entries,
            Err(response) => return response,
        };
        let resolved = match admit_resolved(&entry.arena, &plan, &target, &entry.budgets, parsed) {
            Ok(map) => map,
            Err(response) => return response,
        };
        let outcome = validation::execute(
            &entry.arena,
            &plan,
            &resolve,
            &target,
            validation::ExecBudgets {
                max_nodes: entry.budgets.max_nodes,
                max_depth: entry.budgets.max_depth,
            },
            &resolved,
        );
        ok(validation::outcome_to_json(&outcome))
    }

    /// Disposes one request: idempotent success/error/cancel release at
    /// the request seam. Unknown ids are silent no-ops like plan
    /// release; every request runs under `try/finally` host-side.
    fn op_request_dispose(&mut self, args: &Value) -> Value {
        match args.get("request").and_then(Value::as_u64) {
            Some(request) => {
                self.requests.remove(&request);
                ok(Value::Null)
            }
            None => transport_err("args/malformed", None),
        }
    }

    /// Runs one versioned scaffold request. Version, op and args gates
    /// run before any arena build or registration.
    pub fn handle_line(&mut self, line: &str) -> Value {
        // The envelope parses iteratively (no hidden nesting cap):
        // depth lets the owning request budgets decide at the arena,
        // and only genuine syntax errors refuse here as malformed.
        // The request value drops through the iterative destructor
        // on every exit, so no release path grows the native stack.
        let request: Value = match parse_json_line(line) {
            Ok(request) => request,
            Err(()) => return transport_err("args/malformed", None),
        };
        let response = self.dispatch_request(&request);
        drop_value_stack(request);
        response
    }

    fn dispatch_request(&mut self, request: &Value) -> Value {
        match request.get("v").and_then(Value::as_u64) {
            Some(version) if version == STRUCTURAL_ABI as u64 => {}
            Some(_) => return transport_err("version/unsupported", None),
            None => return transport_err("version/malformed", None),
        }
        let op = match request.get("op").and_then(Value::as_str) {
            Some(op) => op,
            None => return transport_err("op/unknown", None),
        };
        let args = match request.get("args") {
            Some(args) if args.is_object() => args,
            _ => return transport_err("args/malformed", None),
        };
        match op {
            "input.digest" => self.op_input_digest(args),
            "owner.create" => self.op_owner_create(args),
            "plan.register" => self.op_plan_register(args),
            "plan.get" => self.op_plan_get(args),
            "plan.release" => self.op_plan_release(args),
            "owner.retire" => self.op_owner_retire(args),
            "request.begin" => self.op_request_begin(args),
            "values.coverage" => self.op_values_coverage(args),
            "values.execute" => self.op_values_execute(args),
            "request.dispose" => self.op_request_dispose(args),
            _ => transport_err("op/unknown", None),
        }
    }
}

