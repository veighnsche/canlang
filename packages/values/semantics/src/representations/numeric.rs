//! Numeric carriers and JS-observable input values.
//!
//! `Value` mirrors what the TypeScript surface can observe: bigints, JS
//! numbers, strings, booleans, null/undefined, well-formed carriers, ordered
//! records (possibly malformed structural probes) and opaque others
//! (symbols, functions). Guards read records field-by-field exactly like the
//! TypeScript `is*` guards, so operation-specific checks keep their order,
//! codes and messages.

use num_bigint::BigInt;
use num_traits::{One, Signed, ToPrimitive, Zero};

use crate::failures::{Failure, ValueFailureCode};

/// Minimum signed 64-bit integer.
pub fn int64_min() -> BigInt {
    -BigInt::one() << 63
}

/// Maximum signed 64-bit integer.
pub fn int64_max() -> BigInt {
    (BigInt::one() << 63) - BigInt::one()
}

/// Minimum signed 64-bit integer as i128 (fits by construction).
pub const INT64_MIN: i128 = i64::MIN as i128;
/// Maximum signed 64-bit integer as i128 (fits by construction).
pub const INT64_MAX: i128 = i64::MAX as i128;

/// Maximum fractional digits of a Can decimal.
pub const DECIMAL_MAX_SCALE: u8 = 18;
/// Maximum significant digits of a Can decimal.
pub const DECIMAL_MAX_SIGNIFICANT_DIGITS: usize = 38;

/// First representable instant: 0001-01-01T00:00:00.000Z.
pub const DATETIME_MIN_MS: i128 = -62_135_596_800_000;
/// Last representable instant: 9999-12-31T23:59:59.999Z.
pub const DATETIME_MAX_MS: i128 = 253_402_300_799_999;

/// Decimal digits of |coef| ("0" counts 1). Exact string length, no float math.
pub fn significant_digits(coef: &BigInt) -> usize {
    if coef.is_zero() {
        return 1;
    }
    coef.abs().to_string().len()
}

/// Exact decimal value: unnormalized coefficient plus scale 0..=18.
/// Stored scale is retained, never normalized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecimalParts {
    pub coef: BigInt,
    pub scale: u8,
}

impl DecimalParts {
    /// Checked construction boundary (`new Decimal`): scale breaches and
    /// 38-digit breaches are `out-of-range`; a non-bigint coef is
    /// `invalid-construction` (handled by callers passing typed values).
    pub fn make(coef: BigInt, scale: i64) -> Result<Self, Failure> {
        if scale < 0 || scale > DECIMAL_MAX_SCALE as i64 {
            return Err(Failure::out_of_range(format!(
                "decimal scale out of range 0..18: {scale}"
            )));
        }
        if significant_digits(&coef) > DECIMAL_MAX_SIGNIFICANT_DIGITS {
            return Err(Failure::out_of_range(
                "decimal exceeds 38 significant digits",
            ));
        }
        Ok(DecimalParts {
            coef,
            scale: scale as u8,
        })
    }

    /// Arithmetic-result boundary (`makeDecimalResult`): a computed coef
    /// breaching 38 digits is `overflow`.
    pub fn make_result(coef: BigInt, scale: u8) -> Result<Self, Failure> {
        if significant_digits(&coef) > DECIMAL_MAX_SIGNIFICANT_DIGITS {
            return Err(Failure::overflow(
                "decimal result exceeds 38 significant digits",
            ));
        }
        Ok(DecimalParts { coef, scale })
    }
}

/// Structural money value: bigint minor plus ISO-shaped currency string.
/// Shape-only: no table membership or narrowing happens here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyParts {
    pub minor: BigInt,
    pub currency: String,
}

/// ISO 4217 code shape: exactly three ASCII uppercase letters.
pub fn is_currency_shape(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())
}

/// Checked money-tag constructor (`makeMoney`): shape failures are
/// `invalid-construction`; pinned-table misses are `unknown-currency`.
/// The table lookup is injected so money owns arithmetic, not the table.
pub fn make_money(
    minor: BigInt,
    currency: String,
    table_scale: Option<u8>,
) -> Result<MoneyParts, Failure> {
    if !is_currency_shape(&currency) {
        return Err(Failure::invalid_construction(format!(
            "invalid currency code shape: {currency}"
        )));
    }
    if table_scale.is_none() {
        return Err(Failure::new(
            ValueFailureCode::UnknownCurrency,
            format!("unknown currency: {currency}"),
        ));
    }
    Ok(MoneyParts { minor, currency })
}

/// Civil date value: proleptic Gregorian years 0001-9999.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateParts {
    pub year: i32,
    pub month: u8,
    pub day: u8,
}

/// UTC instant value: integer milliseconds since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatetimeParts {
    pub ms: BigInt,
}

/// A JS-observable input value, as received across the transport boundary.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    BigInt(BigInt),
    Num(f64),
    Str(String),
    Bool(bool),
    Null,
    Undefined,
    Decimal(DecimalParts),
    Money(MoneyParts),
    Date(DateParts),
    Datetime(DatetimeParts),
    Array(Vec<Value>),
    /// Ordered structural probe; fields mirror `Object.entries` order.
    /// Malformed carriers arrive in this form so guards observe them exactly
    /// like the TypeScript guards observe arbitrary objects.
    Record(Vec<(String, Value)>),
    /// Opaque non-value: symbol, function, bigint-incompatible exotic input.
    Other(String),
}

impl Value {
    pub fn record_field(&self, name: &str) -> Option<&Value> {
        match self {
            Value::Record(entries) => entries
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn record_kind(&self) -> Option<&str> {
        match self.record_field("kind") {
            Some(Value::Str(kind)) => Some(kind.as_str()),
            _ => None,
        }
    }
}

/// `Number.isInteger` over a transport f64: finite with no fractional part.
/// Note `-0` is an integer, matching TypeScript.
pub fn is_integer_number(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

/// Guard for valid decimal values: shape, scale range and 38-digit bound
/// (`isDecimal`). Well-formed carriers always pass; records are checked
/// field by field.
pub fn is_decimal_value(value: &Value) -> bool {
    match value {
        Value::Decimal(_) => true,
        Value::Record(_) => {
            if value.record_kind() != Some("decimal") {
                return false;
            }
            let (Some(Value::BigInt(coef)), Some(Value::Num(scale))) =
                (value.record_field("coef"), value.record_field("scale"))
            else {
                return false;
            };
            if !is_integer_number(*scale) {
                return false;
            }
            if *scale < 0.0 || *scale > DECIMAL_MAX_SCALE as f64 {
                return false;
            }
            significant_digits(coef) <= DECIMAL_MAX_SIGNIFICANT_DIGITS
        }
        _ => false,
    }
}

/// Shape guard for money values (`isMoney`): kind/minor/currency shape only,
/// no table membership proof.
pub fn is_money_value(value: &Value) -> bool {
    match value {
        Value::Money(_) => true,
        Value::Record(_) => {
            if value.record_kind() != Some("money") {
                return false;
            }
            let (Some(Value::BigInt(_)), Some(Value::Str(currency))) =
                (value.record_field("minor"), value.record_field("currency"))
            else {
                return false;
            };
            is_currency_shape(currency)
        }
        _ => false,
    }
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn valid_date_parts(year: f64, month: f64, day: f64) -> Option<DateParts> {
    if !is_integer_number(year) || !is_integer_number(month) || !is_integer_number(day) {
        return None;
    }
    if year < 1.0 || year > 9999.0 || month < 1.0 || month > 12.0 {
        return None;
    }
    let (year, month, day) = (year as i32, month as u8, day as u8);
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(DateParts { year, month, day })
}

/// Guard for valid civil dates (`isDateValue`).
pub fn is_date_value(value: &Value) -> bool {
    match value {
        Value::Date(_) => true,
        Value::Record(_) => {
            if value.record_kind() != Some("date") {
                return false;
            }
            let (Some(Value::Num(year)), Some(Value::Num(month)), Some(Value::Num(day))) = (
                value.record_field("year"),
                value.record_field("month"),
                value.record_field("day"),
            ) else {
                return false;
            };
            valid_date_parts(*year, *month, *day).is_some()
        }
        _ => false,
    }
}

/// Guard for datetime values (`isDatetime`): kind plus bigint ms, no range check.
pub fn is_datetime_value(value: &Value) -> bool {
    match value {
        Value::Datetime(_) => true,
        Value::Record(_) => {
            value.record_kind() == Some("datetime")
                && matches!(value.record_field("ms"), Some(Value::BigInt(_)))
        }
        _ => false,
    }
}

/// Checked civil-date constructor (`makeDate`): each part must be an integer
/// (`invalid-construction`), then the combination must be a real civil date.
pub fn make_date(year: f64, month: f64, day: f64) -> Result<DateParts, Failure> {
    for (label, part) in [("year", year), ("month", month), ("day", day)] {
        if !is_integer_number(part) {
            return Err(Failure::invalid_construction(format!(
                "date {label} must be an integer"
            )));
        }
    }
    valid_date_parts(year, month, day).ok_or_else(|| {
        // Mirrors `invalid civil date: ${year}-${month}-${day}` with JS
        // number formatting for the parts.
        Failure::invalid_construction(format!(
            "invalid civil date: {}-{}-{}",
            format_js_number(year),
            format_js_number(month),
            format_js_number(day)
        ))
    })
}

/// Formats an f64 the way TypeScript `String(number)` does: shortest
/// round-trip digits, plain notation for magnitudes in [1e-6, 1e21),
/// `Ne±M` exponent form outside it (`-0` prints as `0`).
pub fn format_js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    let abs = value.abs();
    if abs >= 1e21 || abs < 1e-6 {
        // Rust `{:e}` uses shortest digits; reformat the exponent with an
        // explicit sign and no leading zeros, like JavaScript.
        let raw = format!("{value:e}");
        let (mantissa, exp) = raw.split_once('e').expect("exponent form");
        let exp: i32 = exp.parse().expect("numeric exponent");
        return format!("{mantissa}e{exp:+}");
    }
    format!("{value}")
}

/// Range-checks ms against the decided 0001-9999 UTC range
/// (`assertDatetimeInRange`).
pub fn assert_datetime_in_range(ms: &BigInt) -> Result<(), Failure> {
    let min = BigInt::from(DATETIME_MIN_MS);
    let max = BigInt::from(DATETIME_MAX_MS);
    if ms < &min || ms > &max {
        return Err(Failure::out_of_range(
            "datetime outside the supported 0001-9999 range",
        ));
    }
    Ok(())
}

/// Checked UTC-instant constructor (`makeDatetime`).
pub fn make_datetime(ms: BigInt) -> Result<DatetimeParts, Failure> {
    assert_datetime_in_range(&ms)?;
    Ok(DatetimeParts { ms })
}

/// `requireBigint`/`requireDuration`/`requireInt`: bigint or
/// `invalid-construction`.
pub fn require_bigint<'a>(value: &'a Value, what: &str) -> Result<&'a BigInt, Failure> {
    match value {
        Value::BigInt(int) => Ok(int),
        _ => Err(Failure::invalid_construction(format!(
            "{what} must be a bigint"
        ))),
    }
}

/// Duration guard message variant (`requireDuration`).
pub fn require_duration<'a>(value: &'a Value, what: &str) -> Result<&'a BigInt, Failure> {
    match value {
        Value::BigInt(int) => Ok(int),
        _ => Err(Failure::invalid_construction(format!(
            "{what} must be a duration (bigint ms)"
        ))),
    }
}

/// Int guard message variant (`requireInt` in temporal).
pub fn require_temporal_int<'a>(value: &'a Value, what: &str) -> Result<&'a BigInt, Failure> {
    match value {
        Value::BigInt(int) => Ok(int),
        _ => Err(Failure::invalid_construction(format!(
            "{what} must be an int (bigint)"
        ))),
    }
}

/// Checked int64 narrowing (`int64`): non-bigint is `invalid-construction`,
/// out-of-range is `overflow`.
pub fn require_int64(value: &Value) -> Result<i64, Failure> {
    let int = require_bigint(value, "int64")?;
    narrow_int64(int, "int64")
}

/// Narrows an exact bigint to int64 with the `int64` overflow message.
pub fn narrow_int64(value: &BigInt, what: &str) -> Result<i64, Failure> {
    if what == "int64" {
        let min = int64_min();
        let max = int64_max();
        if value < &min || value > &max {
            return Err(Failure::overflow(format!("int64 out of range: {value}")));
        }
    } else if value < &int64_min() || value > &int64_max() {
        return Err(Failure::overflow(format!("{what} overflows int64")));
    }
    // Range-checked above; the conversion cannot fail.
    Ok(value.to_i64().expect("range-checked int64 converts"))
}

/// Temporal `checkInt64`: same range, `{what} overflows int64` message.
pub fn check_int64_temporal(value: &BigInt, what: &str) -> Result<i64, Failure> {
    narrow_int64(value, what)
}

/// Extracts decimal parts with int promotion (`toDecimalParts`).
pub fn decimal_parts(value: &Value, what: &str) -> Result<DecimalParts, Failure> {
    match value {
        Value::BigInt(coef) => Ok(DecimalParts {
            coef: coef.clone(),
            scale: 0,
        }),
        Value::Decimal(parts) => Ok(parts.clone()),
        Value::Record(_) if is_decimal_value(value) => {
            let coef = match value.record_field("coef") {
                Some(Value::BigInt(coef)) => coef.clone(),
                _ => {
                    return Err(Failure::invalid_construction(format!(
                        "{what} must be a decimal or bigint"
                    )));
                }
            };
            let scale = match value.record_field("scale") {
                Some(Value::Num(scale)) => *scale as u8,
                _ => {
                    return Err(Failure::invalid_construction(format!(
                        "{what} must be a decimal or bigint"
                    )));
                }
            };
            Ok(DecimalParts { coef, scale })
        }
        _ => Err(Failure::invalid_construction(format!(
            "{what} must be a decimal or bigint"
        ))),
    }
}

/// Structural money parts without any guard (`asMoneyParts`): kind/minor/
/// currency shape only; table membership is not consulted.
pub fn money_parts_unchecked(value: &Value) -> Option<MoneyParts> {
    match value {
        Value::Money(parts) => Some(parts.clone()),
        Value::Record(_) => {
            if value.record_kind() != Some("money") {
                return None;
            }
            let (Some(Value::BigInt(minor)), Some(Value::Str(currency))) =
                (value.record_field("minor"), value.record_field("currency"))
            else {
                return None;
            };
            Some(MoneyParts {
                minor: minor.clone(),
                currency: currency.clone(),
            })
        }
        _ => None,
    }
}

/// Money guard (`requireMoney` via `isMoney`).
pub fn require_money(value: &Value, what: &str) -> Result<MoneyParts, Failure> {
    if !is_money_value(value) {
        return Err(Failure::invalid_construction(format!(
            "{what} must be a money value"
        )));
    }
    money_parts_unchecked(value)
        .ok_or_else(|| Failure::invalid_construction(format!("{what} must be a money value")))
}

/// Date guard (`requireDate`).
pub fn require_date(value: &Value, what: &str) -> Result<DateParts, Failure> {
    match value {
        Value::Date(parts) => Ok(parts.clone()),
        Value::Record(_) => {
            let (Some(Value::Num(year)), Some(Value::Num(month)), Some(Value::Num(day))) = (
                value.record_field("year"),
                value.record_field("month"),
                value.record_field("day"),
            ) else {
                return Err(Failure::invalid_construction(format!(
                    "{what} must be a date value"
                )));
            };
            if value.record_kind() != Some("date") {
                return Err(Failure::invalid_construction(format!(
                    "{what} must be a date value"
                )));
            }
            valid_date_parts(*year, *month, *day).ok_or_else(|| {
                Failure::invalid_construction(format!("{what} must be a date value"))
            })
        }
        _ => Err(Failure::invalid_construction(format!(
            "{what} must be a date value"
        ))),
    }
}

/// Datetime guard (`requireDatetime`).
pub fn require_datetime(value: &Value, what: &str) -> Result<DatetimeParts, Failure> {
    match value {
        Value::Datetime(parts) => Ok(parts.clone()),
        Value::Record(_)
            if value.record_kind() == Some("datetime")
                && matches!(value.record_field("ms"), Some(Value::BigInt(_))) =>
        {
            match value.record_field("ms") {
                Some(Value::BigInt(ms)) => Ok(DatetimeParts { ms: ms.clone() }),
                _ => Err(Failure::invalid_construction(format!(
                    "{what} must be a datetime value"
                ))),
            }
        }
        _ => Err(Failure::invalid_construction(format!(
            "{what} must be a datetime value"
        ))),
    }
}

/// Integer-valued JS number guard for scale/date-part style inputs.
pub fn require_integer_number(value: &Value, what: &str) -> Result<f64, Failure> {
    match value {
        Value::Num(number) if is_integer_number(*number) => Ok(*number),
        _ => Err(Failure::invalid_construction(format!(
            "{what} must be an integer"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimum_int64_remainder_is_zero_not_panic() {
        // Guard for the i64::MIN % -1 trap: core math never narrows operands.
        let min = int64_min();
        let minus_one = BigInt::from(-1);
        assert!((min % minus_one).is_zero());
    }
}
