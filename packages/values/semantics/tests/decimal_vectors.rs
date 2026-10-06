//! Native decimal vectors (A04.1/A04.2): construction, parsing, stored
//! parts, math, both ratio branches, and canonical text.

use num_bigint::BigInt;
use values_semantics::numeric::decimal::*;
use values_semantics::representations::numeric::{DecimalParts, Value};

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

fn parts(value: Result<DecimalParts, values_semantics::failures::Failure>) -> (String, u8) {
    let parts = value.unwrap();
    (parts.coef.to_string(), parts.scale)
}

#[test]
fn add_aligns_at_max_scale_without_rounding() {
    assert_eq!(
        parts(add_decimal(&dec("1", 0.0), &dec("5", 1.0))),
        ("15".to_string(), 1)
    );
    assert_eq!(
        parts(add_decimal(&bi("2"), &dec("25", 2.0))),
        ("225".to_string(), 2)
    );
    // 38-digit result is fine; 39 digits overflow.
    let max38 = "9".repeat(38);
    assert_eq!(parts(add_decimal(&dec(&max38, 0.0), &bi("0"))).0.len(), 38);
    let err = add_decimal(&dec(&max38, 0.0), &bi("1")).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
    assert_eq!(err.message, "decimal result exceeds 38 significant digits");
}

#[test]
fn subtract_and_promotion() {
    assert_eq!(
        parts(subtract_decimal(&dec("100", 2.0), &bi("1"))),
        ("0".to_string(), 2)
    );
    let err = subtract_decimal(&Value::Str("1".to_string()), &bi("1")).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
    assert_eq!(err.message, "subtractDecimal must be a decimal or bigint");
}

#[test]
fn multiply_rounds_only_past_18_places() {
    assert_eq!(
        parts(multiply_decimal(&dec("1", 1.0), &dec("1", 1.0))),
        ("1".to_string(), 2)
    );
    // Exact scale 20 > 18: half-even to 18 places.
    let wide = "1".to_string() + &"0".repeat(19);
    let out = multiply_decimal(&dec(&wide, 10.0), &dec(&wide, 10.0)).unwrap();
    assert_eq!(out.scale, 18);
    // 40-digit exact product overflows even at a fitting scale.
    let d20 = "9".repeat(20);
    let err = multiply_decimal(&dec(&d20, 0.0), &dec(&d20, 0.0)).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
}

#[test]
fn divide_keeps_terminating_minimal_scale() {
    assert_eq!(
        parts(divide_decimal(&bi("1"), &bi("2"))),
        ("5".to_string(), 1)
    );
    assert_eq!(
        parts(divide_decimal(&bi("1"), &bi("8"))),
        ("125".to_string(), 3)
    );
    assert_eq!(
        parts(divide_decimal(&bi("6"), &bi("3"))),
        ("2".to_string(), 0)
    );
    assert_eq!(
        parts(divide_decimal(&dec("1", 2.0), &dec("4", 2.0))),
        ("25".to_string(), 2)
    );
}

#[test]
fn divide_rounds_repeating_half_even_at_18() {
    let (coef, scale) = parts(divide_decimal(&bi("1"), &bi("3")));
    assert_eq!(scale, 18);
    assert_eq!(coef, "3".repeat(18));
    let (coef, scale) = parts(divide_decimal(&bi("2"), &bi("3")));
    assert_eq!(scale, 18);
    assert_eq!(coef, "6".repeat(17) + "7");
    let err = divide_decimal(&bi("1"), &bi("0")).unwrap_err();
    assert_eq!(err.code.as_str(), "division-by-zero");
}

#[test]
fn money_ratio_branch_is_structurally_weak() {
    // Same-currency minors divide like integers; no table check here.
    assert_eq!(
        parts(divide_decimal(&money("1", "ZZZ"), &money("2", "ZZZ"))),
        ("5".to_string(), 1)
    );
    let err = divide_decimal(&money("1", "USD"), &money("2", "EUR")).unwrap_err();
    assert_eq!(err.code.as_str(), "currency-mismatch");
    let err = divide_decimal(&money("1", "USD"), &bi("2")).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
}

#[test]
fn divide_duration_narrows_inputs_first() {
    assert_eq!(
        parts(divide_duration_ms(&bi("1"), &bi("2"))),
        ("5".to_string(), 1)
    );
    let err = divide_duration_ms(&bi("9223372036854775808"), &bi("1")).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
    let err = divide_duration_ms(&Value::Num(1.0), &bi("1")).unwrap_err();
    assert_eq!(
        err.message,
        "divideDurationMs needs bigint millisecond inputs"
    );
}

#[test]
fn negate_abs_round() {
    assert_eq!(parts(negate_decimal(&dec("5", 3.0))), ("-5".to_string(), 3));
    assert_eq!(parts(abs_decimal(&dec("-5", 3.0))), ("5".to_string(), 3));
    // Ties to even at scale 0.
    assert_eq!(
        parts(round_decimal(&dec("25", 1.0), &Value::Num(0.0))),
        ("2".to_string(), 0)
    );
    assert_eq!(
        parts(round_decimal(&dec("35", 1.0), &Value::Num(0.0))),
        ("4".to_string(), 0)
    );
    // Rounding up rescales exactly; breaching rescales overflow.
    assert_eq!(
        parts(round_decimal(&dec("1", 0.0), &Value::Num(18.0))).1,
        18
    );
    let err = round_decimal(&dec(&"9".repeat(38), 0.0), &Value::Num(1.0)).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
    let err = round_decimal(&bi("1"), &Value::Num(19.0)).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    let err = round_decimal(&bi("1"), &Value::Num(1.5)).unwrap_err();
    assert_eq!(err.message, "round scale must be an integer");
}

#[test]
fn compare_and_equal_cross_scales() {
    assert_eq!(
        compare_decimal(&dec("10", 1.0), &dec("100", 2.0)).unwrap(),
        0
    );
    assert!(equal_decimal(&dec("10", 1.0), &dec("100", 2.0)).unwrap());
    assert_eq!(compare_decimal(&bi("1"), &dec("9", 1.0)).unwrap(), 1);
}

#[test]
fn parse_grammar_and_bounds() {
    assert_eq!(
        parts(parse_decimal(&Value::Str("1.50".to_string()))),
        ("150".to_string(), 2)
    );
    assert_eq!(
        parts(parse_decimal(&Value::Str("-0".to_string()))),
        ("0".to_string(), 0)
    );
    assert_eq!(
        parts(parse_decimal(&Value::Str("007".to_string()))),
        ("7".to_string(), 0)
    );
    for bad in ["1e3", "+1", "1,000", "1.", ".5", "", "-", "abc", "1.5.5"] {
        let err = parse_decimal(&Value::Str(bad.to_string())).unwrap_err();
        assert_eq!(err.code.as_str(), "invalid-construction", "for {bad:?}");
    }
    let err = parse_decimal(&Value::Str("1.0000000000000000001".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    let err = parse_decimal(&Value::Str("9".repeat(39))).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    let err = parse_decimal(&bi("1")).unwrap_err();
    assert_eq!(err.message, "parseDecimal needs a string");
}

#[test]
fn integer_construction_and_canonical_text() {
    assert_eq!(
        parts(decimal_from_integer(&bi("123"))),
        ("123".to_string(), 0)
    );
    // Representation breach at construction: out-of-range, never overflow.
    let err = decimal_from_integer(&bi(&"9".repeat(39))).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    assert_eq!(decimal_to_string(&dec("0", 18.0)).unwrap(), "0");
    assert_eq!(decimal_to_string(&dec("150", 2.0)).unwrap(), "1.5");
    assert_eq!(decimal_to_string(&dec("100", 2.0)).unwrap(), "1");
    assert_eq!(decimal_to_string(&dec("-5", 3.0)).unwrap(), "-0.005");
    assert_eq!(decimal_to_string(&dec("5", 0.0)).unwrap(), "5");
    let err = decimal_to_string(&bi("5")).unwrap_err();
    assert_eq!(err.message, "decimalToString needs a decimal");
}
