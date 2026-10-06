//! Native temporal vectors (A05): civil math, instants, durations,
//! ranges, limits, and overload precedence.

use num_bigint::BigInt;
use values_semantics::representations::numeric::Value;
use values_semantics::temporal::civil::*;
use values_semantics::temporal::duration::*;
use values_semantics::temporal::instant::*;

fn bi(text: &str) -> Value {
    Value::BigInt(text.parse::<BigInt>().unwrap())
}

fn date(year: f64, month: f64, day: f64) -> Value {
    Value::Record(vec![
        ("kind".to_string(), Value::Str("date".to_string())),
        ("year".to_string(), Value::Num(year)),
        ("month".to_string(), Value::Num(month)),
        ("day".to_string(), Value::Num(day)),
    ])
}

fn datetime(ms: &str) -> Value {
    Value::Record(vec![
        ("kind".to_string(), Value::Str("datetime".to_string())),
        (
            "ms".to_string(),
            Value::BigInt(ms.parse::<BigInt>().unwrap()),
        ),
    ])
}

#[test]
fn civil_roundtrip_and_leap_edges() {
    assert_eq!(days_from_civil(1970, 1, 1), 0);
    assert_eq!(days_from_civil(1, 1, 1), -719162);
    assert_eq!(days_from_civil(9999, 12, 31), 2_932_896);
    assert_eq!(civil_from_days(-719162), (1, 1, 1));
    assert_eq!(civil_from_days(2_932_896), (9999, 12, 31));
    // 2024 is a leap year; 1900 is not.
    assert_eq!(
        days_from_civil(2024, 3, 1) - days_from_civil(2024, 2, 1),
        29
    );
    assert_eq!(
        days_from_civil(1900, 3, 1) - days_from_civil(1900, 2, 1),
        28
    );
    assert_eq!(date_to_epoch_days(&date(2024.0, 2.0, 29.0)).unwrap(), 19782);
}

#[test]
fn epoch_days_conversion_checks() {
    let out = epoch_days_to_date(&Value::Num(0.0)).unwrap();
    assert_eq!((out.year, out.month, out.day), (1970, 1, 1));
    let err = epoch_days_to_date(&Value::Num(1.5)).unwrap_err();
    assert_eq!(err.message, "epoch days must be an integer");
    let err = epoch_days_to_date(&Value::Num(2_932_897.0)).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    let err = epoch_days_to_date(&bi("0")).unwrap_err();
    assert_eq!(err.message, "epoch days must be an integer");
}

#[test]
fn date_text_constructor() {
    let out = parse_date(&Value::Str("2024-02-29".to_string())).unwrap();
    assert_eq!((out.year, out.month, out.day), (2024, 2, 29));
    let err = parse_date(&Value::Str("0000-01-01".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    let err = parse_date(&Value::Str("2023-02-29".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
    assert_eq!(err.message, "invalid civil date: 2023-02-29");
    let err = parse_date(&Value::Str("2024-13-01".to_string())).unwrap_err();
    assert_eq!(err.message, "invalid civil date: 2024-13-01");
    let err = parse_date(&Value::Str("24-01-01".to_string())).unwrap_err();
    assert_eq!(err.message, "invalid date text: 24-01-01");
    let err = parse_date(&bi("1")).unwrap_err();
    assert_eq!(err.message, "date() requires text");
}

#[test]
fn datetime_text_constructor() {
    let out = parse_datetime(&Value::Str("1970-01-01T00:00:00.000Z".to_string())).unwrap();
    assert_eq!(out.ms.to_string(), "0");
    // Lowercase t/z and offsets are accepted by the public parser.
    let out = parse_datetime(&Value::Str("1970-01-01t01:00:00z".to_string())).unwrap();
    assert_eq!(out.ms.to_string(), "3600000");
    let out = parse_datetime(&Value::Str("1970-01-01T01:00:00+01:00".to_string())).unwrap();
    assert_eq!(out.ms.to_string(), "0");
    let out = parse_datetime(&Value::Str("1970-01-01T00:00:00.5Z".to_string())).unwrap();
    assert_eq!(out.ms.to_string(), "500");
    // Trailing zero sub-ms digits are fine; nonzero digits fail.
    let out = parse_datetime(&Value::Str("1970-01-01T00:00:00.000000Z".to_string())).unwrap();
    assert_eq!(out.ms.to_string(), "0");
    let err = parse_datetime(&Value::Str("1970-01-01T00:00:00.000001Z".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "invalid-construction");
    // Leap second 60 is rejected.
    let err = parse_datetime(&Value::Str("2016-12-31T23:59:60Z".to_string())).unwrap_err();
    assert_eq!(err.message, "invalid time of day: 2016-12-31T23:59:60Z");
    // Offset bounds and missing offset.
    let err = parse_datetime(&Value::Str("1970-01-01T00:00:00+24:00".to_string())).unwrap_err();
    assert_eq!(
        err.message,
        "invalid zone offset: 1970-01-01T00:00:00+24:00"
    );
    let err = parse_datetime(&Value::Str("1970-01-01T00:00:00".to_string())).unwrap_err();
    assert_eq!(err.message, "invalid datetime text: 1970-01-01T00:00:00");
    let err = parse_datetime(&Value::Str("0000-01-01T00:00:00Z".to_string())).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
}

#[test]
fn add_days_months_clamp_and_bound() {
    let out = add_days(&date(2024.0, 1.0, 31.0), &bi("1")).unwrap();
    assert_eq!((out.year, out.month, out.day), (2024, 2, 1));
    // Month-end clamping keeps the original day capped at the target month.
    let out = add_months(&date(2024.0, 1.0, 31.0), &bi("1")).unwrap();
    assert_eq!((out.year, out.month, out.day), (2024, 2, 29));
    let out = add_months(&date(2024.0, 1.0, 31.0), &bi("2")).unwrap();
    assert_eq!((out.year, out.month, out.day), (2024, 3, 31));
    let err = add_days(&date(9999.0, 12.0, 31.0), &bi("1")).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    let err = add_months(&date(9999.0, 12.0, 1.0), &bi("1")).unwrap_err();
    assert_eq!(err.code.as_str(), "out-of-range");
    assert_eq!(
        date_year(&date(2024.0, 6.0, 1.0)).unwrap().to_string(),
        "2024"
    );
    // 1970-01-01 and 2024-02-29 were both Thursdays (ISO 4).
    assert_eq!(weekday(&date(1970.0, 1.0, 1.0)).unwrap().to_string(), "4");
    assert_eq!(weekday(&date(2024.0, 2.0, 29.0)).unwrap().to_string(), "4");
}

#[test]
fn dates_half_open_limit_order() {
    // Equal endpoints: frozen-equivalent empty, limit VALUE never consulted.
    let out = dates(&date(2024.0, 1.0, 1.0), &date(2024.0, 1.0, 1.0), &bi("0")).unwrap();
    assert!(out.is_empty());
    // ...but the limit TYPE is checked before the count checks.
    let err = dates(
        &date(2024.0, 1.0, 1.0),
        &date(2024.0, 1.0, 1.0),
        &Value::Str("x".to_string()),
    )
    .unwrap_err();
    assert_eq!(err.message, "dates limit must be an int (bigint)");
    let err = dates(&date(2024.0, 1.0, 2.0), &date(2024.0, 1.0, 1.0), &bi("10")).unwrap_err();
    assert_eq!(err.message, "dates from must not be after until");
    let err = dates(&date(2024.0, 1.0, 1.0), &date(2024.0, 1.0, 3.0), &bi("0")).unwrap_err();
    assert_eq!(err.message, "dates limit must be positive");
    let err = dates(&date(2024.0, 1.0, 1.0), &date(2024.0, 1.0, 4.0), &bi("2")).unwrap_err();
    assert_eq!(err.code.as_str(), "limit-exceeded");
    assert_eq!(err.message, "dates range of 3 exceeds limit 2");
    let out = dates(&date(2024.0, 1.0, 1.0), &date(2024.0, 1.0, 3.0), &bi("2")).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!((out[1].year, out[1].month, out[1].day), (2024, 1, 2));
}

#[test]
fn overlaps_dates_datetimes_and_mixes() {
    let (a, b, c, d) = (
        date(2024.0, 1.0, 1.0),
        date(2024.0, 1.0, 5.0),
        date(2024.0, 1.0, 3.0),
        date(2024.0, 1.0, 7.0),
    );
    assert!(overlaps(&a, &b, &c, &d).unwrap());
    // Touching half-open ranges do not overlap.
    assert!(!overlaps(&a, &c, &c, &d).unwrap());
    // Empty ranges return false.
    assert!(!overlaps(&a, &a, &c, &d).unwrap());
    assert!(overlaps(
        &datetime("0"),
        &datetime("10"),
        &datetime("5"),
        &datetime("15")
    )
    .unwrap());
    assert!(!overlaps(
        &datetime("0"),
        &datetime("5"),
        &datetime("5"),
        &datetime("10")
    )
    .unwrap());
    let err = overlaps(&a, &b, &c, &datetime("0")).unwrap_err();
    assert_eq!(
        err.message,
        "overlaps requires four dates or four datetimes"
    );
}

#[test]
fn duration_arithmetic_is_int64_checked() {
    assert_eq!(
        add_duration(&bi("1"), &bi("2")).unwrap(),
        DurationSum::Duration(3)
    );
    let err = match add_duration(&bi("9223372036854775807"), &bi("1")) {
        Err(f) => f,
        _ => panic!("expected overflow"),
    };
    assert_eq!(err.code.as_str(), "overflow");
    assert_eq!(multiply_duration(&bi("3"), &bi("4")).unwrap(), 12);
    assert_eq!(
        divide_duration_by_int(&bi("7"), &bi("2")).map_err(|e| e.code.as_str().to_string()),
        Err("inexact".to_string())
    );
    assert_eq!(divide_duration_by_int(&bi("6"), &bi("3")).unwrap(), 2);
    let err = divide_duration_by_int(&bi("1"), &bi("0")).unwrap_err();
    assert_eq!(err.code.as_str(), "division-by-zero");
    assert_eq!(remainder_duration(&bi("-7"), &bi("3")).unwrap(), -1);
    assert_eq!(compare_duration(&bi("1"), &bi("2")).unwrap(), -1);
    let err = negate_duration(&bi("-9223372036854775808")).unwrap_err();
    assert_eq!(err.code.as_str(), "overflow");
    // Guard messages distinguish duration/int positions.
    let err = multiply_duration(&Value::Num(1.0), &bi("1")).unwrap_err();
    assert_eq!(
        err.message,
        "duration factor must be a duration (bigint ms)"
    );
    let err = multiply_duration(&bi("1"), &Value::Num(1.0)).unwrap_err();
    assert_eq!(err.message, "duration factor must be an int (bigint)");
}

#[test]
fn datetime_overloads_range_check_without_narrowing() {
    // Duration + datetime: no int64 narrowing of the sum, only range.
    let out = add_duration(&bi("1000"), &datetime("0")).unwrap();
    match out {
        DurationSum::Datetime(parts) => assert_eq!(parts.ms.to_string(), "1000"),
        _ => panic!("expected datetime"),
    }
    let out = subtract_duration(&datetime("1000"), &bi("1000")).unwrap();
    match out {
        DurationSum::Datetime(parts) => assert_eq!(parts.ms.to_string(), "0"),
        _ => panic!("expected datetime"),
    }
    let err = match add_duration(&bi("1"), &datetime("253402300799999")) {
        Err(f) => f,
        _ => panic!("expected out-of-range"),
    };
    assert_eq!(err.code.as_str(), "out-of-range");
    let err = add_duration(&datetime("0"), &datetime("0")).unwrap_err();
    assert_eq!(
        err.message,
        "addDuration requires (duration,duration), (duration,datetime) or (datetime,duration)"
    );
}

#[test]
fn instant_and_date_comparisons() {
    assert_eq!(
        duration_between(&datetime("10"), &datetime("4")).unwrap(),
        6
    );
    assert_eq!(compare_instant(&datetime("1"), &datetime("2")).unwrap(), -1);
    assert_eq!(
        compare_date(&date(2024.0, 1.0, 1.0), &date(2024.0, 1.0, 1.0)).unwrap(),
        0
    );
    assert_eq!(
        compare_date(&date(2023.0, 12.0, 31.0), &date(2024.0, 1.0, 1.0)).unwrap(),
        -1
    );
}
