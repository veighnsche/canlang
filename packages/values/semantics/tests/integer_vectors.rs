//! Native integer vectors (A03.2): unrestricted operands, result-only
//! int64 narrowing, truncating remainder, total comparison.

use num_bigint::BigInt;
use values_semantics::numeric::integer::*;
use values_semantics::representations::numeric::Value;

fn bi(text: &str) -> Value {
    Value::BigInt(text.parse::<BigInt>().unwrap())
}

fn num(value: f64) -> Value {
    Value::Num(value)
}

fn code_of(result: Result<i64, values_semantics::failures::Failure>) -> String {
    result.unwrap_err().code.as_str().to_string()
}

#[test]
fn int64_bounds_and_messages() {
    assert_eq!(int64(&bi("0")).unwrap(), 0);
    assert_eq!(int64(&bi("-9223372036854775808")).unwrap(), i64::MIN);
    assert_eq!(int64(&bi("9223372036854775807")).unwrap(), i64::MAX);
    let err = int64(&bi("9223372036854775808")).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
    assert_eq!(err.message, "int64 out of range: 9223372036854775808");
    let err = int64(&bi("-9223372036854775809")).unwrap_err();
    assert_eq!(err.message, "int64 out of range: -9223372036854775809");
    let err = int64(&num(5.0)).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
    assert_eq!(err.message, "int64 must be a bigint");
}

#[test]
fn add_sub_mul_check_only_the_result() {
    // Operands may be arbitrarily wide; only the result narrows.
    assert_eq!(
        add_int(
            &bi("1000000000000000000000000000000"),
            &bi("-999999999999999999999999999999")
        )
        .unwrap(),
        1
    );
    assert_eq!(
        code_of(add_int(&bi("9223372036854775807"), &bi("1"))),
        "overflow"
    );
    assert_eq!(
        code_of(subtract_int(&bi("-9223372036854775808"), &bi("1"))),
        "overflow"
    );
    assert_eq!(
        code_of(multiply_int(&bi("3037000500"), &bi("3037000500"))),
        "overflow"
    );
}

#[test]
fn mul_min_by_minus_one_overflows() {
    assert_eq!(
        code_of(multiply_int(&bi("-1"), &bi("-9223372036854775808"))),
        "overflow"
    );
}

#[test]
fn remainder_truncates_with_dividend_sign() {
    assert_eq!(mod_int(&bi("7"), &bi("3")).unwrap(), 1);
    assert_eq!(mod_int(&bi("-7"), &bi("3")).unwrap(), -1);
    assert_eq!(mod_int(&bi("7"), &bi("-3")).unwrap(), 1);
    assert_eq!(mod_int(&bi("-7"), &bi("-3")).unwrap(), -1);
    // Minimum-int64 remainder by -1 is zero, not an arithmetic trap.
    assert_eq!(mod_int(&bi("-9223372036854775808"), &bi("-1")).unwrap(), 0);
    let err = mod_int(&bi("1"), &bi("0")).unwrap_err();
    assert_eq!(err.code.as_str(), "division-by-zero");
    assert_eq!(err.message, "int remainder with zero divisor");
}

#[test]
fn negate_abs_share_the_min_boundary() {
    assert_eq!(negate_int(&bi("5")).unwrap(), -5);
    assert_eq!(code_of(negate_int(&bi("-9223372036854775808"))), "overflow");
    assert_eq!(abs_int(&bi("-5")).unwrap(), 5);
    assert_eq!(abs_int(&bi("0")).unwrap(), 0);
    assert_eq!(code_of(abs_int(&bi("-9223372036854775808"))), "overflow");
    // `requireBigint` runs before the sign branch: every non-bigint
    // reports the absInt caller.
    let err = abs_int(&num(5.0)).unwrap_err();
    assert_eq!(err.message, "absInt must be a bigint");
    let err = abs_int(&num(-5.0)).unwrap_err();
    assert_eq!(err.message, "absInt must be a bigint");
    let err = abs_int(&Value::Str("5".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
}

#[test]
fn compare_is_total_and_unbounded() {
    let wide = "1".to_string() + &"0".repeat(1000);
    let wider = "1".to_string() + &"0".repeat(1001);
    assert_eq!(compare_int(&bi(&wide), &bi(&wider)).unwrap(), -1);
    assert_eq!(compare_int(&bi(&wider), &bi(&wide)).unwrap(), 1);
    assert_eq!(compare_int(&bi(&wide), &bi(&wide)).unwrap(), 0);
    assert_eq!(compare_int(&bi("-5"), &bi("5")).unwrap(), -1);
    assert!(compare_int(&num(1.0), &bi("1")).is_err());
}
