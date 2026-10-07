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
pub fn handle_line(line: &str) -> Json {
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
