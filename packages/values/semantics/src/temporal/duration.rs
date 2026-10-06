//! Pure-bigint duration arithmetic (`temporal.ts` duration builtins).
//!
//! Durations are int64-checked integer milliseconds. Mixed
//! duration/datetime overloads live here with the duration-named helpers.

use num_bigint::BigInt;
use num_traits::Zero;

use crate::failures::Failure;
use crate::representations::numeric::{
    assert_datetime_in_range, check_int64_temporal, is_datetime_value, make_datetime,
    require_datetime, require_duration, require_temporal_int, DatetimeParts, Value,
};

/// Duration + duration, duration + datetime, datetime + duration
/// (`addDuration` overloads). Duration sums narrow to int64; instant sums
/// range-check to 0001-9999.
pub fn add_duration(a: &Value, b: &Value) -> Result<DurationSum, Failure> {
    match (a, b) {
        (Value::BigInt(left), Value::BigInt(right)) => Ok(DurationSum::Duration(
            check_int64_temporal(&(left + right), "duration addition")?,
        )),
        (Value::BigInt(delta), other) if is_datetime_value(other) => {
            let instant = require_datetime(other, "addDuration")?;
            let sum = delta + &instant.ms;
            assert_datetime_in_range(&sum)?;
            Ok(DurationSum::Datetime(make_datetime(sum)?))
        }
        (other, Value::BigInt(delta)) if is_datetime_value(other) => {
            let instant = require_datetime(other, "addDuration")?;
            let sum = &instant.ms + delta;
            assert_datetime_in_range(&sum)?;
            Ok(DurationSum::Datetime(make_datetime(sum)?))
        }
        _ => Err(Failure::invalid_construction(
            "addDuration requires (duration,duration), (duration,datetime) or (datetime,duration)",
        )),
    }
}

/// Result of the `addDuration` overloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurationSum {
    Duration(i64),
    Datetime(DatetimeParts),
}

/// Duration - duration and datetime - duration (`subtractDuration`).
pub fn subtract_duration(a: &Value, b: &Value) -> Result<DurationSum, Failure> {
    match (a, b) {
        (Value::BigInt(left), Value::BigInt(right)) => Ok(DurationSum::Duration(
            check_int64_temporal(&(left - right), "duration subtraction")?,
        )),
        (other, Value::BigInt(delta)) if is_datetime_value(other) => {
            let instant = require_datetime(other, "subtractDuration")?;
            let sum = &instant.ms - delta;
            assert_datetime_in_range(&sum)?;
            Ok(DurationSum::Datetime(make_datetime(sum)?))
        }
        _ => Err(Failure::invalid_construction(
            "subtractDuration requires (duration,duration) or (datetime,duration)",
        )),
    }
}

/// Duration * int (`multiplyDuration`).
pub fn multiply_duration(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_duration(a, "duration factor")?;
    let right = require_temporal_int(b, "duration factor")?;
    check_int64_temporal(&(left * right), "duration multiplication")
}

/// Duration / int (`divideDurationByInt`): exact milliseconds or `inexact`;
/// zero divisor is `division-by-zero`.
pub fn divide_duration_by_int(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_duration(a, "duration dividend")?;
    let right = require_temporal_int(b, "duration divisor")?;
    if right.is_zero() {
        return Err(Failure::division_by_zero("duration division by zero"));
    }
    if left % right != BigInt::ZERO {
        return Err(Failure::new(
            crate::failures::ValueFailureCode::Inexact,
            "duration division must be exact milliseconds",
        ));
    }
    check_int64_temporal(&(left / right), "duration division")
}

/// Duration % duration (`remainderDuration`): truncating, dividend's sign.
pub fn remainder_duration(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_duration(a, "duration dividend")?;
    let right = require_duration(b, "duration divisor")?;
    if right.is_zero() {
        return Err(Failure::division_by_zero("duration remainder by zero"));
    }
    check_int64_temporal(&(left % right), "duration remainder")
}

/// Duration comparator (`compareDuration`).
pub fn compare_duration(a: &Value, b: &Value) -> Result<i8, Failure> {
    let left = require_duration(a, "duration comparison")?;
    let right = require_duration(b, "duration comparison")?;
    Ok(if left < right {
        -1
    } else if left > right {
        1
    } else {
        0
    })
}

/// Duration negation (`negateDuration`).
pub fn negate_duration(value: &Value) -> Result<i64, Failure> {
    let current = require_duration(value, "duration negation")?;
    check_int64_temporal(&-current, "duration negation")
}

/// Duration absolute value (`absDuration`).
pub fn abs_duration(value: &Value) -> Result<i64, Failure> {
    let current = require_duration(value, "duration abs")?;
    let magnitude = if current < &BigInt::ZERO {
        -current
    } else {
        current.clone()
    };
    check_int64_temporal(&magnitude, "duration abs")
}
