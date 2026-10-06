//! Decimal construction, parsing, math and text (`decimal.ts`).
//!
//! Stored scale 0..=18 is retained; equality is by numeric value across
//! scales. Construction breaches are `out-of-range`; computed results that
//! breach 38 digits are `overflow`; malformed inputs are
//! `invalid-construction`.

use num_bigint::BigInt;
use num_traits::{Signed, Zero};

use crate::failures::Failure;
use crate::numeric::rounding::{pow10, round_rational, round_scaled_half_even};
use crate::representations::numeric::{
    decimal_parts, is_decimal_value, is_integer_number, money_parts_unchecked, require_bigint,
    require_int64, significant_digits, DecimalParts, Value, DECIMAL_MAX_SCALE,
    DECIMAL_MAX_SIGNIFICANT_DIGITS,
};

/// Decimal addition (`addDecimal`): exact sum at max operand scale.
pub fn add_decimal(a: &Value, b: &Value) -> Result<DecimalParts, Failure> {
    let left = decimal_parts(a, "addDecimal")?;
    let right = decimal_parts(b, "addDecimal")?;
    let scale = left.scale.max(right.scale);
    let sum = left.coef * pow10((scale - left.scale) as u32)
        + right.coef * pow10((scale - right.scale) as u32);
    DecimalParts::make_result(sum, scale)
}

/// Decimal subtraction (`subtractDecimal`).
pub fn subtract_decimal(a: &Value, b: &Value) -> Result<DecimalParts, Failure> {
    let left = decimal_parts(a, "subtractDecimal")?;
    let right = decimal_parts(b, "subtractDecimal")?;
    let scale = left.scale.max(right.scale);
    let diff = left.coef * pow10((scale - left.scale) as u32)
        - right.coef * pow10((scale - right.scale) as u32);
    DecimalParts::make_result(diff, scale)
}

/// Decimal multiplication (`multiplyDecimal`): exact product at summed
/// scale when that fits in 18 places, else half-even to 18 places.
pub fn multiply_decimal(a: &Value, b: &Value) -> Result<DecimalParts, Failure> {
    let left = decimal_parts(a, "multiplyDecimal")?;
    let right = decimal_parts(b, "multiplyDecimal")?;
    let exact_scale = left.scale as u32 + right.scale as u32;
    let exact_coef = left.coef * right.coef;
    if exact_scale <= DECIMAL_MAX_SCALE as u32 {
        return DecimalParts::make_result(exact_coef, exact_scale as u8);
    }
    let rounded = round_scaled_half_even(&exact_coef, exact_scale - DECIMAL_MAX_SCALE as u32)?;
    DecimalParts::make_result(rounded, DECIMAL_MAX_SCALE)
}

/// Exact integer-ratio division N/D to a decimal (`divideIntegers`):
/// terminating results keep minimal scale; repeating results round
/// half-even to 18 places via guard digit plus sticky remainder.
pub fn divide_integers(num: &BigInt, den: &BigInt) -> Result<DecimalParts, Failure> {
    if den.is_zero() {
        return Err(Failure::division_by_zero("decimal division by zero"));
    }
    let negative = (num < &BigInt::ZERO) != (den < &BigInt::ZERO);
    let n = num.abs();
    let d = den.abs();
    let int_part = &n / &d;
    let mut rest = &n % &d;
    if rest.is_zero() {
        let coef = if negative { -int_part } else { int_part };
        return DecimalParts::make_result(coef, 0);
    }
    let mut frac = BigInt::ZERO;
    let ten = BigInt::from(10);
    for places in 1..=DECIMAL_MAX_SCALE as u32 {
        rest *= &ten;
        frac = frac * &ten + (&rest / &d);
        rest %= &d;
        if rest.is_zero() {
            let coef = &int_part * pow10(places) + frac;
            let coef = if negative { -coef } else { coef };
            return DecimalParts::make_result(coef, places as u8);
        }
    }
    rest *= &ten;
    let guard = &rest / &d;
    let sticky = &rest % &d;
    let mut coef = &int_part * pow10(DECIMAL_MAX_SCALE as u32) + frac;
    let five = BigInt::from(5);
    let two = BigInt::from(2);
    if guard > five
        || (guard == five && !sticky.is_zero())
        || (guard == five && sticky.is_zero() && (&coef % &two != BigInt::ZERO))
    {
        coef += 1;
    }
    let coef = if negative { -coef } else { coef };
    DecimalParts::make_result(coef, DECIMAL_MAX_SCALE)
}

/// Decimal division (`divideDecimal`): int|decimal operands, plus the
/// structural money/money ratio branch (same currency; weaker guard than
/// `moneyRatio` — no table membership check).
pub fn divide_decimal(a: &Value, b: &Value) -> Result<DecimalParts, Failure> {
    let left_money = money_parts_unchecked(a);
    let right_money = money_parts_unchecked(b);
    if left_money.is_some() || right_money.is_some() {
        match (left_money, right_money) {
            (Some(left), Some(right)) => {
                if left.currency != right.currency {
                    return Err(Failure::new(
                        crate::failures::ValueFailureCode::CurrencyMismatch,
                        "money ratio needs matching currencies",
                    ));
                }
                return divide_integers(&left.minor, &right.minor);
            }
            _ => {
                return Err(Failure::invalid_construction(
                    "divideDecimal takes int|decimal operands or a money/money ratio, never a mix",
                ));
            }
        }
    }
    let left = decimal_parts(a, "divideDecimal")?;
    let right = decimal_parts(b, "divideDecimal")?;
    divide_integers(
        &(left.coef * pow10(right.scale as u32)),
        &(right.coef * pow10(left.scale as u32)),
    )
}

/// Duration/duration division to decimal (`divideDurationMs`): both inputs
/// int64-narrowed at entry, like every other duration op.
pub fn divide_duration_ms(a: &Value, b: &Value) -> Result<DecimalParts, Failure> {
    match (a, b) {
        (Value::BigInt(_), Value::BigInt(_)) => {}
        _ => {
            return Err(Failure::invalid_construction(
                "divideDurationMs needs bigint millisecond inputs",
            ));
        }
    }
    let narrowed_a = require_int64(a)?;
    let narrowed_b = require_int64(b)?;
    divide_integers(&BigInt::from(narrowed_a), &BigInt::from(narrowed_b))
}

/// Decimal unary negation (`negateDecimal`).
pub fn negate_decimal(value: &Value) -> Result<DecimalParts, Failure> {
    if !is_decimal_value(value) {
        return Err(Failure::invalid_construction(
            "negateDecimal needs a decimal",
        ));
    }
    let parts = decimal_parts(value, "negateDecimal")?;
    DecimalParts::make(-parts.coef, parts.scale as i64)
}

/// Decimal absolute value (`absDecimal`).
pub fn abs_decimal(value: &Value) -> Result<DecimalParts, Failure> {
    if !is_decimal_value(value) {
        return Err(Failure::invalid_construction("absDecimal needs a decimal"));
    }
    let parts = decimal_parts(value, "absDecimal")?;
    let coef = if parts.coef < BigInt::ZERO {
        -parts.coef
    } else {
        parts.coef
    };
    DecimalParts::make(coef, parts.scale as i64)
}

/// `round(value, scale)` builtin: integer scale 0..=18, half-even;
/// rounding up rescales exactly, a breaching rescale is `overflow`.
pub fn round_decimal(value: &Value, scale: &Value) -> Result<DecimalParts, Failure> {
    let scale_num = match scale {
        Value::Num(number) if is_integer_number(*number) => *number,
        _ => {
            return Err(Failure::invalid_construction(
                "round scale must be an integer",
            ));
        }
    };
    if scale_num < 0.0 || scale_num > DECIMAL_MAX_SCALE as f64 {
        return Err(Failure::out_of_range(format!(
            "round scale out of range 0..18: {}",
            format_scale(scale_num)
        )));
    }
    let scale_u8 = scale_num as u8;
    let parts = decimal_parts(value, "round")?;
    if scale_u8 >= parts.scale {
        let coef = parts.coef * pow10((scale_u8 - parts.scale) as u32);
        return DecimalParts::make_result(coef, scale_u8);
    }
    let rounded = round_scaled_half_even(&parts.coef, (parts.scale - scale_u8) as u32)?;
    DecimalParts::make_result(rounded, scale_u8)
}

/// Formats a scale for the out-of-range message exactly like
/// `` `round scale out of range 0..18: ${scale}` ``.
fn format_scale(scale: f64) -> String {
    crate::representations::numeric::format_js_number(scale)
}

/// Total decimal comparison (`compareDecimal`): exact, scale-insensitive.
pub fn compare_decimal(a: &Value, b: &Value) -> Result<i8, Failure> {
    let left = decimal_parts(a, "compareDecimal")?;
    let right = decimal_parts(b, "compareDecimal")?;
    let scale = left.scale.max(right.scale);
    let x = left.coef * pow10((scale - left.scale) as u32);
    let y = right.coef * pow10((scale - right.scale) as u32);
    Ok(if x < y {
        -1
    } else if x > y {
        1
    } else {
        0
    })
}

/// Decimal value equality across scales (`equalDecimal`).
pub fn equal_decimal(a: &Value, b: &Value) -> Result<bool, Failure> {
    Ok(compare_decimal(a, b)? == 0)
}

/// Matches `/^(-)?(\d+)(?:\.(\d+))?$/` returning (sign, int_digits, frac_digits).
fn match_decimal_text(text: &str) -> Option<(bool, &str, &str)> {
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (int_digits, frac_digits) = match rest.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (rest, ""),
    };
    if int_digits.is_empty() || !int_digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if !frac_digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A trailing point with empty fraction is rejected by the regex
    // (`(?:\.(\d+))?` requires digits after the point).
    if rest.contains('.') && frac_digits.is_empty() {
        return None;
    }
    Some((negative, int_digits, frac_digits))
}

/// Exact string-only decimal parse (`parseDecimal`): no exponent,
/// separators or `+`. Breaches are `out-of-range`, never silent rounding.
pub fn parse_decimal(text: &Value) -> Result<DecimalParts, Failure> {
    let text = match text {
        Value::Str(text) => text,
        _ => {
            return Err(Failure::invalid_construction("parseDecimal needs a string"));
        }
    };
    let Some((negative, int_digits, frac_digits)) = match_decimal_text(text) else {
        return Err(Failure::invalid_construction(format!(
            "invalid decimal text: {text}"
        )));
    };
    if frac_digits.len() > DECIMAL_MAX_SCALE as usize {
        return Err(Failure::out_of_range(
            "decimal text exceeds 18 fractional digits",
        ));
    }
    let mut digits = String::with_capacity(int_digits.len() + frac_digits.len() + 1);
    if negative {
        digits.push('-');
    }
    digits.push_str(int_digits);
    digits.push_str(frac_digits);
    let coef = BigInt::parse_bytes(digits.as_bytes(), 10).expect("digit-only parse");
    if significant_digits(&coef) > DECIMAL_MAX_SIGNIFICANT_DIGITS {
        return Err(Failure::out_of_range(
            "decimal text exceeds 38 significant digits",
        ));
    }
    DecimalParts::make(coef, frac_digits.len() as i64)
}

/// Canonical construction for integral spellings (`decimalFromInteger`):
/// the bigint is the exact coef at scale 0; no int64 narrowing.
pub fn decimal_from_integer(coef: &Value) -> Result<DecimalParts, Failure> {
    let coef = require_bigint(coef, "decimalFromInteger")
        .map_err(|_| Failure::invalid_construction("decimalFromInteger needs a bigint"))?;
    DecimalParts::make(coef.clone(), 0)
}

/// Canonical normalized decimal text (`decimalToString`): strip fractional
/// zeros, no point when integral, `0` for zero, plain base-10, no exponent.
pub fn decimal_to_string(value: &Value) -> Result<String, Failure> {
    if !is_decimal_value(value) {
        return Err(Failure::invalid_construction(
            "decimalToString needs a decimal",
        ));
    }
    let parts = decimal_parts(value, "decimalToString")?;
    if parts.coef.is_zero() {
        return Ok("0".to_string());
    }
    let negative = parts.coef < BigInt::ZERO;
    let digits = parts.coef.abs().to_string();
    let prefix = if negative { "-" } else { "" };
    if parts.scale == 0 {
        return Ok(format!("{prefix}{digits}"));
    }
    let scale = parts.scale as usize;
    let padded = if digits.len() > scale {
        digits
    } else {
        format!("{:0>width$}", digits, width = scale + 1)
    };
    let int_part = &padded[..padded.len() - scale];
    let frac_part = padded[padded.len() - scale..].trim_end_matches('0');
    if frac_part.is_empty() {
        return Ok(format!("{prefix}{int_part}"));
    }
    Ok(format!("{prefix}{int_part}.{frac_part}"))
}

/// Exposes the shared rational rounder for money conversions.
pub fn round_rational_for_money(num: &BigInt, den: &BigInt) -> Result<BigInt, Failure> {
    round_rational(num, den)
}
