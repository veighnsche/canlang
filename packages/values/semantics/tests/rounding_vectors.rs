//! Native rounding vectors (A03.3): half-even rational rounding with
//! exact scratch operands, ties, sticky digits and error order.

use num_bigint::BigInt;
use values_semantics::numeric::rounding::{round_rational, round_rational_half_even};
use values_semantics::representations::numeric::Value;

fn bi(text: &str) -> BigInt {
    text.parse::<BigInt>().unwrap()
}

fn v(text: &str) -> Value {
    Value::BigInt(bi(text))
}

#[test]
fn ties_go_to_even() {
    assert_eq!(round_rational(&bi("1"), &bi("2")).unwrap(), bi("0"));
    assert_eq!(round_rational(&bi("3"), &bi("2")).unwrap(), bi("2"));
    assert_eq!(round_rational(&bi("5"), &bi("2")).unwrap(), bi("2"));
    assert_eq!(round_rational(&bi("7"), &bi("2")).unwrap(), bi("4"));
}

#[test]
fn negatives_are_symmetric() {
    assert_eq!(round_rational(&bi("-1"), &bi("2")).unwrap(), bi("0"));
    assert_eq!(round_rational(&bi("-3"), &bi("2")).unwrap(), bi("-2"));
    assert_eq!(round_rational(&bi("-5"), &bi("2")).unwrap(), bi("-2"));
}

#[test]
fn negative_denominators_flip_the_sign() {
    assert_eq!(round_rational(&bi("1"), &bi("-2")).unwrap(), bi("0"));
    assert_eq!(round_rational(&bi("3"), &bi("-2")).unwrap(), bi("-2"));
    assert_eq!(round_rational(&bi("-3"), &bi("-2")).unwrap(), bi("2"));
}

#[test]
fn sticky_digits_break_ties() {
    // 5.001 rounds down; 4.999 rounds up toward even 5... check direction:
    // 5001/1000 = 5.001 -> kept 5, rest 1, twice 2 < 1000 -> 5.
    assert_eq!(round_rational(&bi("5001"), &bi("1000")).unwrap(), bi("5"));
    // 4999/1000 = 4.999 -> kept 4, rest 999, twice 1998 > 1000 -> 5.
    assert_eq!(round_rational(&bi("4999"), &bi("1000")).unwrap(), bi("5"));
    // Near tie above: 25001/10000 = 2.5001 -> 3 (odd kept rounds up anyway).
    assert_eq!(round_rational(&bi("25001"), &bi("10000")).unwrap(), bi("3"));
    // Near tie below an even kept: 24999/10000 = 2.4999 -> 2.
    assert_eq!(round_rational(&bi("24999"), &bi("10000")).unwrap(), bi("2"));
}

#[test]
fn zero_denominator_and_type_errors() {
    let err = round_rational(&bi("1"), &bi("0")).unwrap_err();
    assert_eq!(err.code.as_str(), "division-by-zero");
    assert_eq!(err.message, "rounding with zero denominator");
    let err = round_rational_half_even(&Value::Num(1.0), &v("2")).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
    assert_eq!(err.message, "roundRationalHalfEven needs bigint inputs");
    let err = round_rational_half_even(&v("1"), &Value::Null).unwrap_err();
    assert_eq!(err.message, "roundRationalHalfEven needs bigint inputs");
}

#[test]
fn wide_scratch_stays_exact() {
    // 10^100 / 3 rounds from the exact remainder, never a float.
    let num = bi(&("1".to_string() + &"0".repeat(100)));
    let rounded = round_rational(&num, &bi("3")).unwrap();
    // 10^100 = 3q + 1, so it rounds down to q.
    assert_eq!(rounded, (&num - 1) / 3);
}
