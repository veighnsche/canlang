//! Native aggregate vectors (A06): owned-domain sums with final-only
//! narrowing, pass ordering, and empty/currency rules.

use num_bigint::BigInt;
use values_semantics::aggregates::decimal::sum_decimal;
use values_semantics::aggregates::integer::{sum_duration, sum_int};
use values_semantics::aggregates::money::sum_money;
use values_semantics::representations::numeric::Value;

fn bi(text: &str) -> Value {
    Value::BigInt(text.parse::<BigInt>().unwrap())
}

fn dec(coef: &str, scale: f64) -> Value {
    Value::Record(vec![
        ("kind".to_string(), Value::Str("decimal".to_string())),
        (
            "coef".to_string(),
            Value::BigInt(coef.parse::<BigInt>().unwrap()),
        ),
        ("scale".to_string(), Value::Num(scale)),
    ])
}

fn money(minor: &str, currency: &str) -> Value {
    Value::Record(vec![
        ("kind".to_string(), Value::Str("money".to_string())),
        (
            "minor".to_string(),
            Value::BigInt(minor.parse::<BigInt>().unwrap()),
        ),
        ("currency".to_string(), Value::Str(currency.to_string())),
    ])
}

#[test]
fn int_sums_narrow_once() {
    assert_eq!(sum_int(&[]).unwrap(), 0);
    assert_eq!(sum_int(&[bi("1"), bi("2"), bi("3")]).unwrap(), 6);
    // Intermediate totals may leave int64 while the total fits.
    assert_eq!(
        sum_int(&[bi("9223372036854775807"), bi("1"), bi("-1")]).unwrap(),
        9223372036854775807
    );
    let err = sum_int(&[bi("9223372036854775807"), bi("1")]).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
    let err = sum_int(&[bi("1"), Value::Num(2.0)]).unwrap_err();
    assert_eq!(err.message, "sumInt needs int elements");
    assert_eq!(sum_duration(&[]).unwrap(), 0);
    let err = sum_duration(&[Value::Str("x".to_string())]).unwrap_err();
    assert_eq!(err.message, "sumDuration needs duration elements");
}

#[test]
fn decimal_sums_validate_then_align() {
    let out = sum_decimal(&[]).unwrap();
    assert_eq!((out.coef.to_string(), out.scale), ("0".to_string(), 0));
    let out = sum_decimal(&[dec("1", 0.0), dec("5", 1.0)]).unwrap();
    assert_eq!((out.coef.to_string(), out.scale), ("15".to_string(), 1));
    // A malformed element anywhere fails before any summing.
    let err = sum_decimal(&[dec("1", 0.0), bi("2")]).unwrap_err();
    assert_eq!(err.message, "sumDecimal needs decimal elements");
    // Cancellation across aligned scales; single final check.
    let out = sum_decimal(&[
        dec("99999999999999999999", 0.0),
        dec("-99999999999999999999", 0.0),
    ])
    .unwrap();
    assert_eq!((out.coef.to_string(), out.scale), ("0".to_string(), 0));
    let err = sum_decimal(&[dec(&"9".repeat(38), 0.0), dec("1", 0.0)]).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
}

#[test]
fn money_sums_explicit_and_inferred() {
    // Explicit currency: empty sum is that currency's zero.
    let out = sum_money(&[], Some(&Value::Str("USD".to_string()))).unwrap();
    assert_eq!(
        (out.minor.to_string(), out.currency),
        ("0".to_string(), "USD".to_string())
    );
    // Explicit currency validates before elements.
    let err = sum_money(&[], Some(&Value::Str("XXX".to_string()))).unwrap_err();
    assert_eq!(err.code.as_str(), "unknown-currency");
    let out = sum_money(
        &[money("100", "USD"), money("-40", "USD")],
        Some(&Value::Str("USD".to_string())),
    )
    .unwrap();
    assert_eq!(out.minor.to_string(), "60");
    let err = sum_money(
        &[money("100", "USD"), money("1", "EUR")],
        Some(&Value::Str("USD".to_string())),
    )
    .unwrap_err();
    assert_eq!(err.code.as_str(), "currency-mismatch");
    assert_eq!(
        err.message,
        "sumMoney amounts must match the explicit currency"
    );
    // Inferred: empty needs explicit; head currency validated once.
    let err = sum_money(&[], None).unwrap_err();
    assert_eq!(
        err.message,
        "sumMoney of an empty domain needs an explicit currency"
    );
    let out = sum_money(&[money("100", "JPY"), money("50", "JPY")], None).unwrap();
    assert_eq!(
        (out.minor.to_string(), out.currency),
        ("150".to_string(), "JPY".to_string())
    );
    let err = sum_money(&[money("100", "USD"), money("1", "EUR")], None).unwrap_err();
    assert_eq!(err.message, "sumMoney amounts must share one currency");
    let err = sum_money(&[money("100", "ZZZ")], None).unwrap_err();
    assert_eq!(err.code.as_str(), "unknown-currency");
    // Final-only narrowing: intermediate escape is fine.
    let out = sum_money(
        &[
            money("9223372036854775807", "USD"),
            money("1", "USD"),
            money("-1", "USD"),
        ],
        None,
    )
    .unwrap();
    assert_eq!(out.minor.to_string(), "9223372036854775807");
}
