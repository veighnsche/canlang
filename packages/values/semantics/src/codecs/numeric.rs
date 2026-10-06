//! Pure numeric scalar wire codecs (`wire.ts` scalar portions).
//!
//! Canonical exact strings for int/decimal/money/date/datetime/duration.
//! Decode failures accumulate ordered violations (never throw); encode
//! mismatches are caller `ValueError`s. Traversal, schema policy and all
//! other types stay validation-owned.

use num_bigint::BigInt;

use crate::currency_facts::currency_table_scale;
use crate::failures::Failure;
use crate::numeric::decimal::{decimal_to_string, parse_decimal};
use crate::representations::numeric::{
    assert_datetime_in_range, is_date_value, is_datetime_value, is_decimal_value, is_money_value,
    make_date, make_datetime, make_money, narrow_int64, require_bigint, DateParts, DatetimeParts,
    DecimalParts, MoneyParts, Value,
};
use crate::temporal::civil::{civil_from_days, date_to_epoch_days};

/// A wire path segment: object key or array index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSeg {
    Key(String),
    Index(usize),
}

/// Violation codes used by scalar codecs: `type`, `format`, `bound`,
/// `required`, `unknown-field`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViolationCode {
    Type,
    Format,
    Bound,
    Required,
    UnknownField,
}

impl ViolationCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ViolationCode::Type => "type",
            ViolationCode::Format => "format",
            ViolationCode::Bound => "bound",
            ViolationCode::Required => "required",
            ViolationCode::UnknownField => "unknown-field",
        }
    }
}

/// A structured decode violation, mirroring the contract `Violation`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: Vec<PathSeg>,
    pub code: ViolationCode,
    pub message: String,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

impl Violation {
    fn new(
        path: &[PathSeg],
        code: ViolationCode,
        message: String,
        expected: Option<String>,
        actual: Option<String>,
    ) -> Self {
        Violation {
            path: path.to_vec(),
            code,
            message,
            expected,
            actual,
        }
    }
}

struct Ctx {
    violations: Vec<Violation>,
}

impl Ctx {
    fn push(
        &mut self,
        path: &[PathSeg],
        code: ViolationCode,
        message: String,
        expected: Option<String>,
        actual: Option<String>,
    ) {
        self.violations
            .push(Violation::new(path, code, message, expected, actual));
    }

    fn fail_type(&mut self, path: &[PathSeg], what: &str, expected: &str, wire: &Value) {
        self.push(
            path,
            ViolationCode::Type,
            format!("{what} has the wrong wire type"),
            Some(expected.to_string()),
            Some(actual_wire(wire)),
        );
    }

    fn fail_format(&mut self, path: &[PathSeg], what: &str, expected: &str, wire: &Value) {
        self.push(
            path,
            ViolationCode::Format,
            format!("{what} is malformed"),
            Some(expected.to_string()),
            Some(actual_wire(wire)),
        );
    }

    fn fail_bound(&mut self, path: &[PathSeg], what: &str, expected: &str, wire: &Value) {
        self.push(
            path,
            ViolationCode::Bound,
            format!("{what} is out of range"),
            Some(expected.to_string()),
            Some(actual_wire(wire)),
        );
    }
}

/// Short stable description of unexpected wire for `actual` fields
/// (`actualWire`).
pub fn actual_wire(wire: &Value) -> String {
    match wire {
        Value::Null => "null".to_string(),
        Value::Str(text) => truncate(&json_stringify(text), 64),
        Value::Num(number) => format!("number {}", format_js_number_full(*number)),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::BigInt(int) => format!("bigint {int}"),
        Value::Undefined => "undefined".to_string(),
        Value::Array(items) => format!("array of length {}", items.len()),
        Value::Record(entries) => {
            let keys: Vec<&str> = entries.iter().take(5).map(|(k, _)| k.as_str()).collect();
            format!("object with keys [{}]", keys.join(", "))
        }
        // Well-formed carriers are objects on the wire; their observable
        // key sets match the TypeScript class instances.
        Value::Decimal(_) => "object with keys [kind, coef, scale]".to_string(),
        Value::Money(_) => "object with keys [kind, minor, currency]".to_string(),
        Value::Date(_) => "object with keys [kind, year, month, day]".to_string(),
        Value::Datetime(_) => "object with keys [kind, ms]".to_string(),
        Value::Other(tag) => tag.clone(),
    }
}

/// `JSON.stringify` for strings: quotes, backslash and C0 controls escaped
/// (short forms for backspace/formfeed/newline/return/tab, lowercase
/// `\u00xx` otherwise); everything else raw.
pub fn json_stringify(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Truncates to 64 UTF-16 code units plus `...`, like
/// `` `${text.slice(0, 64)}...` ``. If unit 64 would split a surrogate
/// pair, 63 units are kept: Rust strings cannot hold the lone half the
/// JavaScript slice would keep (documented micro-boundary; vectors avoid
/// astral characters straddling the cut).
fn truncate(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_string();
    }
    let mut cut = max;
    if cut > 0
        && (0xD800..0xDC00).contains(&units[cut - 1])
        && units.len() > cut
        && (0xDC00..0xE000).contains(&units[cut])
    {
        cut -= 1;
    }
    let kept = String::from_utf16(&units[..cut]).expect("surrogate-safe cut");
    format!("{kept}...")
}

/// TypeScript `String(number)` formatting, shared with message rendering.
pub use crate::representations::numeric::format_js_number as format_js_number_full;

/// Lenient key read: absent or `undefined`-valued keys count as absent.
fn read_key<'a>(entries: &'a [(String, Value)], key: &str) -> (bool, Option<&'a Value>) {
    match entries.iter().find(|(k, _)| k == key) {
        Some((_, Value::Undefined)) | None => (false, None),
        Some((_, value)) => (true, Some(value)),
    }
}

fn present_keys(entries: &[(String, Value)]) -> Vec<&str> {
    entries
        .iter()
        .filter(|(_, v)| !matches!(v, Value::Undefined))
        .map(|(k, _)| k.as_str())
        .collect()
}

/// Exact-key-shape check: missing keys are `required`, extras are
/// `unknown-field` (`checkShape`).
fn check_shape(
    ctx: &mut Ctx,
    entries: &[(String, Value)],
    path: &[PathSeg],
    what: &str,
    keys: &[&str],
) -> bool {
    let mut ok = true;
    for key in keys {
        if !read_key(entries, key).0 {
            ok = false;
            let mut at = path.to_vec();
            at.push(PathSeg::Key(key.to_string()));
            ctx.push(
                &at,
                ViolationCode::Required,
                format!("{what} is missing {}", json_stringify(key)),
                Some(what.to_string()),
                None,
            );
        }
    }
    for key in present_keys(entries) {
        if !keys.contains(&key) {
            ok = false;
            let mut at = path.to_vec();
            at.push(PathSeg::Key(key.to_string()));
            let actual = entries
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| actual_wire(v))
                .unwrap_or_else(|| "undefined".to_string());
            ctx.push(
                &at,
                ViolationCode::UnknownField,
                format!("{what} has no field {}", json_stringify(key)),
                Some(what.to_string()),
                Some(actual),
            );
        }
    }
    ok
}

fn match_int_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Canonical int64 decimal string to bigint (`decodeInt64`); failures are
/// recorded, never thrown.
fn decode_int64(
    ctx: &mut Ctx,
    wire: &Value,
    path: &[PathSeg],
    what: &str,
    expected: &str,
) -> Option<BigInt> {
    let text = match wire {
        Value::Str(text) => text,
        _ => {
            ctx.fail_type(path, what, expected, wire);
            return None;
        }
    };
    if !match_int_text(text) {
        ctx.fail_format(path, what, expected, wire);
        return None;
    }
    let parsed = BigInt::parse_bytes(text.as_bytes(), 10).expect("digit-only parse");
    match narrow_int64(&parsed, "int64") {
        Ok(narrowed) => Some(BigInt::from(narrowed)),
        Err(_) => {
            ctx.fail_bound(
                path,
                what,
                &format!("int in [{}, {}]", i64::MIN, i64::MAX),
                wire,
            );
            None
        }
    }
}

fn decode_decimal(ctx: &mut Ctx, wire: &Value, path: &[PathSeg]) -> Option<DecimalParts> {
    if !matches!(wire, Value::Str(_)) {
        ctx.fail_type(path, "decimal", "canonical decimal string", wire);
        return None;
    }
    match parse_decimal(wire) {
        Ok(parts) => Some(parts),
        Err(failure) => {
            if failure.code == crate::failures::ValueFailureCode::InvalidConstruction {
                ctx.fail_format(path, "decimal", "canonical decimal string", wire);
            } else {
                ctx.fail_bound(
                    path,
                    "decimal",
                    "at most 38 significant digits and 18 fractional digits",
                    wire,
                );
            }
            None
        }
    }
}

fn decode_money(ctx: &mut Ctx, wire: &Value, path: &[PathSeg]) -> Option<MoneyParts> {
    let Value::Record(entries) = wire else {
        ctx.fail_type(path, "money", "{minor, currency}", wire);
        return None;
    };
    let mut ok = check_shape(
        ctx,
        entries,
        path,
        "money {minor, currency}",
        &["minor", "currency"],
    );
    let mut minor: Option<BigInt> = None;
    let mut currency = String::new();
    let (minor_present, minor_raw) = read_key(entries, "minor");
    if minor_present {
        let mut at = path.to_vec();
        at.push(PathSeg::Key("minor".to_string()));
        match decode_int64(
            ctx,
            minor_raw.expect("present minor"),
            &at,
            "money.minor",
            "canonical int64 string",
        ) {
            Some(value) => minor = Some(value),
            None => ok = false,
        }
    }
    let (currency_present, currency_raw) = read_key(entries, "currency");
    if currency_present {
        let mut at = path.to_vec();
        at.push(PathSeg::Key("currency".to_string()));
        match currency_raw.expect("present currency") {
            Value::Str(code) => {
                if currency_table_scale(code).is_none() {
                    ok = false;
                    ctx.fail_format(
                        &at,
                        "money.currency",
                        "ISO 4217 currency code",
                        currency_raw.expect("present currency"),
                    );
                } else {
                    currency = code.clone();
                }
            }
            other => {
                ok = false;
                ctx.fail_type(&at, "money.currency", "ISO 4217 currency code", other);
            }
        }
    }
    if !ok || minor.is_none() || currency.is_empty() {
        return None;
    }
    make_money(
        minor.expect("decoded minor"),
        currency.clone(),
        currency_table_scale(&currency),
    )
    .ok()
}

fn match_date_text(text: &str) -> Option<(f64, f64, f64)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let part = |from: usize, to: usize| -> Option<f64> {
        let digits = text.get(from..to)?;
        if digits.bytes().all(|b| b.is_ascii_digit()) {
            digits.parse::<f64>().ok()
        } else {
            None
        }
    };
    Some((part(0, 4)?, part(5, 7)?, part(8, 10)?))
}

fn decode_date(ctx: &mut Ctx, wire: &Value, path: &[PathSeg]) -> Option<DateParts> {
    if !matches!(wire, Value::Str(_)) {
        ctx.fail_type(path, "date", "YYYY-MM-DD", wire);
        return None;
    }
    let text = match wire {
        Value::Str(text) => text,
        _ => return None,
    };
    let Some((year, month, day)) = match_date_text(text) else {
        ctx.fail_format(path, "date", "YYYY-MM-DD", wire);
        return None;
    };
    match make_date(year, month, day) {
        Ok(date) => Some(date),
        Err(_) => {
            ctx.fail_format(path, "date", "a real civil date in years 0001-9999", wire);
            None
        }
    }
}

struct PinnedDatetime {
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    milli: u16,
}

/// Matches the pinned wire grammar `YYYY-MM-DDTHH:MM:SS.sssZ` (uppercase
/// `T`/`Z` only, millis required).
fn match_pinned_datetime(text: &str) -> Option<PinnedDatetime> {
    let bytes = text.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    let part = |from: usize, to: usize| -> Option<i32> {
        let digits = text.get(from..to)?;
        if digits.bytes().all(|b| b.is_ascii_digit()) {
            digits.parse::<i32>().ok()
        } else {
            None
        }
    };
    Some(PinnedDatetime {
        year: part(0, 4)?,
        month: part(5, 7)? as u8,
        day: part(8, 10)? as u8,
        hour: part(11, 13)? as u8,
        minute: part(14, 16)? as u8,
        second: part(17, 19)? as u8,
        milli: part(20, 23)? as u16,
    })
}

fn decode_datetime(ctx: &mut Ctx, wire: &Value, path: &[PathSeg]) -> Option<DatetimeParts> {
    if !matches!(wire, Value::Str(_)) {
        ctx.fail_type(path, "datetime", "RFC 3339 UTC with millis", wire);
        return None;
    }
    let text = match wire {
        Value::Str(text) => text,
        _ => return None,
    };
    let Some(fields) = match_pinned_datetime(text) else {
        ctx.fail_format(
            path,
            "datetime",
            "YYYY-MM-DDTHH:MM:SS.sssZ (UTC, millis required)",
            wire,
        );
        return None;
    };
    let days = match make_date(fields.year as f64, fields.month as f64, fields.day as f64) {
        Ok(date) => date_to_epoch_days(&Value::Date(date)).expect("validated date days"),
        Err(_) => {
            ctx.fail_format(
                path,
                "datetime",
                "a real UTC instant in years 0001-9999",
                wire,
            );
            return None;
        }
    };
    if fields.hour > 23 || fields.minute > 59 || fields.second > 59 {
        ctx.fail_format(
            path,
            "datetime",
            "a real UTC instant in years 0001-9999",
            wire,
        );
        return None;
    }
    let ms = BigInt::from(days) * BigInt::from(86_400_000)
        + BigInt::from(
            fields.hour as i64 * 3_600_000
                + fields.minute as i64 * 60_000
                + fields.second as i64 * 1000
                + fields.milli as i64,
        );
    match assert_datetime_in_range(&ms) {
        Ok(()) => make_datetime(ms).ok(),
        Err(_) => {
            ctx.fail_bound(path, "datetime", "an instant in years 0001-9999", wire);
            None
        }
    }
}

/// Scalar type names with pure codecs in this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarName {
    Int,
    Decimal,
    Money,
    Date,
    Datetime,
    Duration,
}

impl ScalarName {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "int" => Some(ScalarName::Int),
            "decimal" => Some(ScalarName::Decimal),
            "money" => Some(ScalarName::Money),
            "date" => Some(ScalarName::Date),
            "datetime" => Some(ScalarName::Datetime),
            "duration" => Some(ScalarName::Duration),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ScalarName::Int => "int",
            ScalarName::Decimal => "decimal",
            ScalarName::Money => "money",
            ScalarName::Date => "date",
            ScalarName::Datetime => "datetime",
            ScalarName::Duration => "duration",
        }
    }
}

/// Decodes wire data for a scalar type id, mirroring `decodeValue` for the
/// six scalar names: the null/undefined prelude, then the scalar branch.
/// Violations accumulate in wire order; success yields a frozen-equivalent
/// `Value`.
pub fn decode_value_scalar(name: ScalarName, wire: &Value) -> Result<Value, Vec<Violation>> {
    let mut ctx = Ctx {
        violations: Vec::new(),
    };
    let printed = name.as_str();
    if matches!(wire, Value::Null) {
        ctx.fail_type(&[], printed, &format!("non-null {printed}"), wire);
        return Err(ctx.violations);
    }
    if matches!(wire, Value::Undefined) {
        ctx.fail_type(&[], printed, printed, wire);
        return Err(ctx.violations);
    }
    let out = match name {
        ScalarName::Int => {
            decode_int64(&mut ctx, wire, &[], "int", "canonical int64 decimal string")
                .map(Value::BigInt)
        }
        ScalarName::Decimal => decode_decimal(&mut ctx, wire, &[]).map(Value::Decimal),
        ScalarName::Money => decode_money(&mut ctx, wire, &[]).map(Value::Money),
        ScalarName::Date => decode_date(&mut ctx, wire, &[]).map(Value::Date),
        ScalarName::Datetime => decode_datetime(&mut ctx, wire, &[]).map(Value::Datetime),
        ScalarName::Duration => decode_int64(
            &mut ctx,
            wire,
            &[],
            "duration",
            "canonical integer-millisecond string",
        )
        .map(Value::BigInt),
    };
    match out {
        Some(value) if ctx.violations.is_empty() => Ok(value),
        _ => Err(ctx.violations),
    }
}

/// A wire output value: strings pass through; money/status objects are
/// ordered key/value maps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireValue {
    Text(String),
    Object(Vec<(String, WireValue)>),
}

/// `$["a"][0]`-style path rendering for encode messages (`formatPath`).
fn format_path(path: &[PathSeg]) -> String {
    if path.is_empty() {
        return "$".to_string();
    }
    let mut out = String::from("$");
    for seg in path {
        match seg {
            PathSeg::Index(index) => out.push_str(&format!("[{index}]")),
            PathSeg::Key(key) => out.push_str(&format!("[{}]", json_stringify(key))),
        }
    }
    out
}

fn encode_error(message: String, path: &[PathSeg]) -> Failure {
    Failure::invalid_construction(format!("{message} at {}", format_path(path)))
}

fn encode_int64(value: &Value, what: &str, path: &[PathSeg]) -> Result<String, Failure> {
    let int = require_bigint(value, what)
        .map_err(|_| encode_error(format!("{what} must be a bigint"), path))?;
    let min = BigInt::from(i64::MIN);
    let max = BigInt::from(i64::MAX);
    if int < &min || int > &max {
        return Err(encode_error(
            format!("{what} out of 64-bit range: {int}"),
            path,
        ));
    }
    Ok(int.to_string())
}

fn encode_date(value: &Value, path: &[PathSeg]) -> Result<String, Failure> {
    if !is_date_value(value) {
        return Err(encode_error("expected a date value".to_string(), path));
    }
    let parts = crate::representations::numeric::require_date(value, "encodeDate")
        .expect("guarded date parts");
    Ok(format!(
        "{:04}-{:02}-{:02}",
        parts.year, parts.month, parts.day
    ))
}

fn encode_datetime(value: &Value, path: &[PathSeg]) -> Result<String, Failure> {
    if !is_datetime_value(value) {
        return Err(encode_error("expected a datetime value".to_string(), path));
    }
    let parts = crate::representations::numeric::require_datetime(value, "encodeDatetime")
        .expect("guarded datetime parts");
    if assert_datetime_in_range(&parts.ms).is_err() {
        return Err(encode_error(
            "datetime outside the supported 0001-9999 range".to_string(),
            path,
        ));
    }
    let day_ms = BigInt::from(86_400_000);
    let mut days = &parts.ms / &day_ms;
    let mut rem = &parts.ms % &day_ms;
    if rem < BigInt::from(0) {
        days -= 1;
        rem += &day_ms;
    }
    let days_i64: i64 = days.to_string().parse().expect("in-range epoch days");
    let (year, month, day) = civil_from_days(days_i64);
    let day_ms_num: i64 = rem.to_string().parse().expect("sub-day millis");
    let hour = day_ms_num / 3_600_000;
    let minute = (day_ms_num % 3_600_000) / 60_000;
    let second = (day_ms_num % 60_000) / 1000;
    let milli = day_ms_num % 1000;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z"
    ))
}

fn encode_money_value(value: &Value, path: &[PathSeg]) -> Result<WireValue, Failure> {
    if !is_money_value(value) {
        return Err(encode_error("expected a money value".to_string(), path));
    }
    let parts = crate::representations::numeric::require_money(value, "encodeMoney")
        .expect("guarded money parts");
    if currency_table_scale(&parts.currency).is_none() {
        let mut at = path.to_vec();
        at.push(PathSeg::Key("currency".to_string()));
        return Err(encode_error(
            format!("unknown currency {}", json_stringify(&parts.currency)),
            &at,
        ));
    }
    let mut at = path.to_vec();
    at.push(PathSeg::Key("minor".to_string()));
    let minor = encode_int64(&Value::BigInt(parts.minor), "money.minor", &at)?;
    Ok(WireValue::Object(vec![
        ("minor".to_string(), WireValue::Text(minor)),
        ("currency".to_string(), WireValue::Text(parts.currency)),
    ]))
}

/// Encodes a value for a scalar type id, mirroring `encodeValue` for the
/// six scalar names. Mismatches are caller errors.
pub fn encode_value_scalar(name: ScalarName, value: &Value) -> Result<WireValue, Failure> {
    let path: Vec<PathSeg> = Vec::new();
    match name {
        ScalarName::Int => encode_int64(value, "int", &path).map(WireValue::Text),
        ScalarName::Decimal => {
            if !is_decimal_value(value) {
                return Err(encode_error("expected a decimal value".to_string(), &path));
            }
            decimal_to_string(value).map(WireValue::Text)
        }
        ScalarName::Money => encode_money_value(value, &path),
        ScalarName::Date => encode_date(value, &path).map(WireValue::Text),
        ScalarName::Datetime => encode_datetime(value, &path).map(WireValue::Text),
        ScalarName::Duration => encode_int64(value, "duration", &path).map(WireValue::Text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_format_spot_checks() {
        assert_eq!(format_js_number_full(0.0), "0");
        assert_eq!(format_js_number_full(-0.0), "0");
        assert_eq!(format_js_number_full(5.0), "5");
        assert_eq!(format_js_number_full(-3.25), "-3.25");
        assert_eq!(format_js_number_full(1e21), "1e+21");
        assert_eq!(format_js_number_full(1.5e-7), "1.5e-7");
        assert_eq!(format_js_number_full(f64::NAN), "NaN");
        assert_eq!(format_js_number_full(f64::INFINITY), "Infinity");
        assert_eq!(format_js_number_full(f64::NEG_INFINITY), "-Infinity");
    }
}
