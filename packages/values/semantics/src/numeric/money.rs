//! Money arithmetic (`money.ts`).
//!
//! The pinned currency/scale table comes from owner-derived facts
//! (`currency_facts.rs`, generated from `currency-data.ts`). Money math
//! computes an exact rational and rounds once before int64 narrowing.
//! Currency-error precedence and the maker-vs-arithmetic narrowing
//! distinction are preserved: structural construction never narrows.

use num_bigint::BigInt;
use num_traits::Zero;

use crate::currency_facts::currency_table_scale;
use crate::failures::{Failure, ValueFailureCode};
use crate::numeric::decimal::{divide_integers, round_rational_for_money};
use crate::numeric::rounding::{pow10, round_rational};
use crate::representations::numeric::{
    decimal_parts, is_decimal_value, make_money, narrow_int64, require_bigint, require_money,
    DecimalParts, MoneyParts, Value,
};

/// Pinned minor-unit scale for a currency code (`currencyScale`).
/// Non-strings are `invalid-construction`; non-members are
/// `unknown-currency`, well-formed or not.
pub fn currency_scale(currency: &Value) -> Result<u8, Failure> {
    let code = match currency {
        Value::Str(code) => code,
        _ => {
            return Err(Failure::invalid_construction("currency must be a string"));
        }
    };
    currency_table_scale(code).ok_or_else(|| {
        Failure::new(
            ValueFailureCode::UnknownCurrency,
            format!("unknown currency: {code}"),
        )
    })
}

/// Pinned-table membership probe (`isKnownCurrency`).
pub fn is_known_currency(currency: &Value) -> bool {
    match currency {
        Value::Str(code) => currency_table_scale(code).is_some(),
        _ => false,
    }
}

/// Round-half-even of coef/10^drop to minor units (drop > 0, unbounded).
fn round_decimal_to_minor(coef: &BigInt, drop: u32) -> Result<BigInt, Failure> {
    round_rational(coef, &pow10(drop))
}

/// `money(value, currency)` checked constructor: validates membership,
/// converts int|decimal exactly, rounds ONCE half-even to the pinned
/// minor-unit scale, then checks `minor:int`.
pub fn make_money_value(value: &Value, currency: &Value) -> Result<MoneyParts, Failure> {
    let scale = currency_scale(currency)?;
    let code = match currency {
        Value::Str(code) => code.clone(),
        _ => {
            return Err(Failure::invalid_construction("currency must be a string"));
        }
    };
    let minor = match value {
        Value::BigInt(int) => int * pow10(scale as u32),
        other if is_decimal_value(other) => {
            let parts = decimal_parts(other, "money")?;
            if parts.scale <= scale {
                parts.coef * pow10((scale - parts.scale) as u32)
            } else {
                round_decimal_to_minor(&parts.coef, (parts.scale - scale) as u32)?
            }
        }
        _ => {
            return Err(Failure::invalid_construction(
                "money value must be int or decimal",
            ));
        }
    };
    let narrowed = narrow_int64(&minor, "int64")?;
    let table_scale = currency_table_scale(&code);
    make_money(BigInt::from(narrowed), code, table_scale)
}

/// Money addition (`addMoney`): same currency, exact minor sum, int64-checked.
pub fn add_money(a: &Value, b: &Value) -> Result<MoneyParts, Failure> {
    let left = require_money(a, "addMoney")?;
    let right = require_money(b, "addMoney")?;
    if left.currency != right.currency {
        return Err(Failure::new(
            ValueFailureCode::CurrencyMismatch,
            "money addition needs matching currencies",
        ));
    }
    let minor = narrow_int64(&(left.minor + right.minor), "int64")?;
    make_money(
        BigInt::from(minor),
        left.currency.clone(),
        currency_table_scale(&left.currency),
    )
}

/// Money subtraction (`subtractMoney`).
pub fn subtract_money(a: &Value, b: &Value) -> Result<MoneyParts, Failure> {
    let left = require_money(a, "subtractMoney")?;
    let right = require_money(b, "subtractMoney")?;
    if left.currency != right.currency {
        return Err(Failure::new(
            ValueFailureCode::CurrencyMismatch,
            "money subtraction needs matching currencies",
        ));
    }
    let minor = narrow_int64(&(left.minor - right.minor), "int64")?;
    make_money(
        BigInt::from(minor),
        left.currency.clone(),
        currency_table_scale(&left.currency),
    )
}

/// Factor guard: bigint or decimal (`requireFactor`).
fn require_factor(value: &Value, what: &str) -> Result<Factor, Failure> {
    match value {
        Value::BigInt(int) => Ok(Factor::Int(int.clone())),
        other if is_decimal_value(other) => Ok(Factor::Decimal(decimal_parts(other, what)?)),
        _ => Err(Failure::invalid_construction(format!(
            "{what} factor must be int or decimal"
        ))),
    }
}

enum Factor {
    Int(BigInt),
    Decimal(DecimalParts),
}

/// Money scaling (`multiplyMoney`): exact rational minor result rounded
/// ONCE half-even, then int64-checked.
pub fn multiply_money(m: &Value, factor: &Value) -> Result<MoneyParts, Failure> {
    let amount = require_money(m, "multiplyMoney")?;
    let minor = match require_factor(factor, "multiplyMoney")? {
        Factor::Int(int) => amount.minor * int,
        Factor::Decimal(parts) => {
            round_decimal_to_minor(&(amount.minor * parts.coef), parts.scale as u32)?
        }
    };
    let narrowed = narrow_int64(&minor, "int64")?;
    make_money(
        BigInt::from(narrowed),
        amount.currency.clone(),
        currency_table_scale(&amount.currency),
    )
}

/// Money division (`divideMoney`): exact rational minor result rounded
/// ONCE half-even, then int64-checked. Zero factors fail.
pub fn divide_money(m: &Value, divisor: &Value) -> Result<MoneyParts, Failure> {
    let amount = require_money(m, "divideMoney")?;
    let minor = match require_factor(divisor, "divideMoney")? {
        Factor::Int(int) => {
            if int.is_zero() {
                return Err(Failure::division_by_zero("money division by zero"));
            }
            round_rational_for_money(&amount.minor, &int)?
        }
        Factor::Decimal(parts) => {
            if parts.coef.is_zero() {
                return Err(Failure::division_by_zero("money division by zero"));
            }
            let scaled = amount.minor * pow10(parts.scale as u32);
            round_rational_for_money(&scaled, &parts.coef)?
        }
    };
    let narrowed = narrow_int64(&minor, "int64")?;
    make_money(
        BigInt::from(narrowed),
        amount.currency.clone(),
        currency_table_scale(&amount.currency),
    )
}

/// Money/money ratio to decimal (`moneyRatio`): guarded (full money
/// values), same currency, exact decimal division.
pub fn money_ratio(a: &Value, b: &Value) -> Result<DecimalParts, Failure> {
    let left = require_money(a, "moneyRatio")?;
    let right = require_money(b, "moneyRatio")?;
    if left.currency != right.currency {
        return Err(Failure::new(
            ValueFailureCode::CurrencyMismatch,
            "money ratio needs matching currencies",
        ));
    }
    divide_integers(&left.minor, &right.minor)
}

/// Money ordering (`compareMoney`): unlike currencies FAIL.
pub fn compare_money(a: &Value, b: &Value) -> Result<i8, Failure> {
    let left = require_money(a, "compareMoney")?;
    let right = require_money(b, "compareMoney")?;
    if left.currency != right.currency {
        return Err(Failure::new(
            ValueFailureCode::CurrencyMismatch,
            "money comparison needs matching currencies",
        ));
    }
    Ok(if left.minor < right.minor {
        -1
    } else if left.minor > right.minor {
        1
    } else {
        0
    })
}

/// Money equality (`equalMoney`): decidable across currencies —
/// mismatches are unequal (false), never an error.
pub fn equal_money(a: &Value, b: &Value) -> Result<bool, Failure> {
    let left = require_money(a, "equalMoney")?;
    let right = require_money(b, "equalMoney")?;
    Ok(left.currency == right.currency && left.minor == right.minor)
}

/// Money unary negation (`negateMoney`).
pub fn negate_money(m: &Value) -> Result<MoneyParts, Failure> {
    let amount = require_money(m, "negateMoney")?;
    let minor = crate::numeric::integer::negate_int(&Value::BigInt(amount.minor.clone()));
    // `negateInt` on a known bigint only fails on INT64_MIN overflow;
    // propagate that exact failure.
    let minor = minor?;
    make_money(
        BigInt::from(minor),
        amount.currency.clone(),
        currency_table_scale(&amount.currency),
    )
}

/// Money absolute value (`absMoney`).
pub fn abs_money(m: &Value) -> Result<MoneyParts, Failure> {
    let amount = require_money(m, "absMoney")?;
    let minor = crate::numeric::integer::abs_int(&Value::BigInt(amount.minor.clone()))?;
    make_money(
        BigInt::from(minor),
        amount.currency.clone(),
        currency_table_scale(&amount.currency),
    )
}

/// Structural money construction without narrowing (`makeMoney` maker).
/// Wide minors are preserved here; arithmetic narrows at its own boundary.
pub fn make_money_structural(minor: &Value, currency: &Value) -> Result<MoneyParts, Failure> {
    let minor = require_bigint(minor, "money minor")
        .map_err(|_| Failure::invalid_construction("money minor must be a bigint"))?;
    let code = match currency {
        Value::Str(code) => code.clone(),
        _ => {
            // Mirrors `isCurrencyShape(currency)`: a non-string code fails
            // the shape check. The template prints the JS value; transport
            // probes only send strings here (other kinds stay TS-observed).
            return Err(Failure::invalid_construction(
                "invalid currency code shape: ".to_string() + &format_non_string(currency),
            ));
        }
    };
    make_money(minor.clone(), code.clone(), currency_table_scale(&code))
}

fn format_non_string(value: &Value) -> String {
    match value {
        Value::Num(n) => crate::representations::numeric::format_js_number(*n),
        Value::Bool(b) => format!("{b}"),
        Value::Null => "null".to_string(),
        Value::Undefined => "undefined".to_string(),
        Value::BigInt(i) => format!("{i}"),
        _ => "[object Object]".to_string(),
    }
}
