//! Native money vectors (A04.3/A04.4): currency facts, maker vs
//! arithmetic narrowing, one-rounding, precedence, and ratio guards.

use num_bigint::BigInt;
use values_semantics::numeric::money::*;
use values_semantics::representations::numeric::{MoneyParts, Value};

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

fn minor_of(value: Result<MoneyParts, values_semantics::failures::Failure>) -> (String, String) {
    let parts = value.unwrap();
    (parts.minor.to_string(), parts.currency)
}

#[test]
fn currency_table_and_membership() {
    assert_eq!(currency_scale(&Value::Str("USD".to_string())).unwrap(), 2);
    assert_eq!(currency_scale(&Value::Str("JPY".to_string())).unwrap(), 0);
    assert_eq!(currency_scale(&Value::Str("BHD".to_string())).unwrap(), 3);
    assert_eq!(currency_scale(&Value::Str("CLF".to_string())).unwrap(), 4);
    let err = currency_scale(&Value::Str("XXX".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "unknown-currency");
    assert_eq!(err.message, "unknown currency: XXX");
    let err = currency_scale(&bi("5")).unwrap_err();
    assert_eq!(err.message, "currency must be a string");
    assert!(is_known_currency(&Value::Str("EUR".to_string())));
    assert!(!is_known_currency(&Value::Str("ZZZ".to_string())));
    assert!(!is_known_currency(&bi("5")));
}

#[test]
fn maker_preserves_wide_minor_without_narrowing() {
    // Structural construction never narrows: 10^100 minor is kept.
    let wide = "1".to_string() + &"0".repeat(100);
    let (minor, currency) = minor_of(make_money_structural(
        &bi(&wide),
        &Value::Str("USD".to_string()),
    ));
    assert_eq!(minor, wide);
    assert_eq!(currency, "USD");
    // Shape failures are invalid-construction; table misses unknown-currency.
    let err = make_money_structural(&bi("1"), &Value::Str("eur".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
    let err = make_money_structural(&bi("1"), &Value::Str("ZZZ".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "unknown-currency");
    let err = make_money_structural(&Value::Num(1.0), &Value::Str("USD".to_string())).unwrap_err();
    assert_eq!(err.message, "money minor must be a bigint");
}

#[test]
fn builtin_converts_and_rounds_once() {
    assert_eq!(
        minor_of(make_money_value(&bi("1"), &Value::Str("USD".to_string()))),
        ("100".to_string(), "USD".to_string())
    );
    // 1.005 USD: scale 3 > 2, half-even 100.5 -> 100 (one rounding).
    assert_eq!(
        minor_of(make_money_value(
            &dec("1005", 3.0),
            &Value::Str("USD".to_string())
        )),
        ("100".to_string(), "USD".to_string())
    );
    // 1.015 USD: 101.5 -> 102 (tie to even, away from 101).
    assert_eq!(
        minor_of(make_money_value(
            &dec("1015", 3.0),
            &Value::Str("USD".to_string())
        )),
        ("102".to_string(), "USD".to_string())
    );
    let err =
        make_money_value(&Value::Str("1".to_string()), &Value::Str("USD".to_string())).unwrap_err();
    assert_eq!(err.message, "money value must be int or decimal");
    let err = make_money_value(&bi("1"), &Value::Str("XXX".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "unknown-currency");
}

#[test]
fn add_sub_require_matching_currencies() {
    assert_eq!(
        minor_of(add_money(&money("100", "USD"), &money("50", "USD"))),
        ("150".to_string(), "USD".to_string())
    );
    let err = add_money(&money("100", "USD"), &money("50", "EUR")).unwrap_err();
    assert_eq!(err.code.as_str(), "currency-mismatch");
    assert_eq!(err.message, "money addition needs matching currencies");
    assert_eq!(
        minor_of(subtract_money(&money("100", "USD"), &money("150", "USD"))),
        ("-50".to_string(), "USD".to_string())
    );
    let err = subtract_money(&money("100", "USD"), &bi("1")).unwrap_err();
    assert_eq!(err.message, "subtractMoney must be a money value");
}

#[test]
fn multiply_divide_round_once_then_narrow() {
    // 100 minor * 1.5 -> 150 exactly.
    assert_eq!(
        minor_of(multiply_money(&money("100", "USD"), &dec("15", 1.0))),
        ("150".to_string(), "USD".to_string())
    );
    // 100 minor * 3 (int factor) -> 300.
    assert_eq!(
        minor_of(multiply_money(&money("100", "USD"), &bi("3"))),
        ("300".to_string(), "USD".to_string())
    );
    // 100 / 3 -> 33.333... -> 33.
    assert_eq!(
        minor_of(divide_money(&money("100", "USD"), &bi("3"))),
        ("33".to_string(), "USD".to_string())
    );
    let err = divide_money(&money("100", "USD"), &bi("0")).unwrap_err();
    assert_eq!(err.code.as_str(), "division-by-zero");
    let err = divide_money(&money("100", "USD"), &dec("0", 2.0)).unwrap_err();
    assert_eq!(err.code.as_str(), "division-by-zero");
    let err = multiply_money(&money("100", "USD"), &Value::Str("x".to_string())).unwrap_err();
    assert_eq!(err.message, "multiplyMoney factor must be int or decimal");
}

#[test]
fn guarded_ratio_differs_from_weak_divide_branch() {
    // moneyRatio requires full money values: malformed shapes fail here
    // (divideDecimal's structural branch would accept them).
    let malformed = Value::Record(vec![
        ("kind".to_string(), Value::Str("money".to_string())),
        ("minor".to_string(), bi("1")),
        ("currency".to_string(), Value::Str("usd".to_string())),
    ]);
    let err = money_ratio(&malformed, &money("2", "USD")).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
    let err = money_ratio(&money("1", "USD"), &money("2", "EUR")).unwrap_err();
    assert_eq!(err.code.as_str(), "currency-mismatch");
    let ratio = money_ratio(&money("1", "USD"), &money("8", "USD")).unwrap();
    assert_eq!(
        (ratio.coef.to_string(), ratio.scale),
        ("125".to_string(), 3)
    );
}

#[test]
fn compare_fails_but_equal_decides_across_currencies() {
    assert_eq!(
        compare_money(&money("1", "USD"), &money("2", "USD")).unwrap(),
        -1
    );
    let err = compare_money(&money("1", "USD"), &money("1", "EUR")).unwrap_err();
    assert_eq!(err.code.as_str(), "currency-mismatch");
    assert!(!equal_money(&money("1", "USD"), &money("1", "EUR")).unwrap());
    assert!(equal_money(&money("1", "USD"), &money("1", "USD")).unwrap());
}

#[test]
fn negate_abs_overflow_at_min() {
    assert_eq!(
        minor_of(negate_money(&money("5", "USD"))),
        ("-5".to_string(), "USD".to_string())
    );
    let err = negate_money(&money("-9223372036854775808", "USD")).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
    let err = abs_money(&money("-9223372036854775808", "USD")).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
}
