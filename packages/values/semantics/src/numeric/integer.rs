//! Unrestricted integer mechanisms (`int.ts`).
//!
//! Operands stay arbitrary-precision; only results narrow to int64.
//! Comparison never narrows. Remainder truncates toward zero (dividend's
//! sign); `INT64_MIN % -1` is zero, computed on BigInt so no arithmetic
//! trap can fire.

use num_bigint::BigInt;

use crate::failures::Failure;
use crate::representations::numeric::{narrow_int64, require_bigint, require_int64, Value};

/// Checked int64 narrowing (`int64`).
pub fn int64(value: &Value) -> Result<i64, Failure> {
    require_int64(value)
}

/// Checked int64 addition (`addInt`): exact sum must fit.
pub fn add_int(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_bigint(a, "addInt")?;
    let right = require_bigint(b, "addInt")?;
    narrow_int64(&(left + right), "int64")
}

/// Checked int64 subtraction (`subtractInt`).
pub fn subtract_int(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_bigint(a, "subtractInt")?;
    let right = require_bigint(b, "subtractInt")?;
    narrow_int64(&(left - right), "int64")
}

/// Checked int64 multiplication (`multiplyInt`).
pub fn multiply_int(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_bigint(a, "multiplyInt")?;
    let right = require_bigint(b, "multiplyInt")?;
    narrow_int64(&(left * right), "int64")
}

/// Checked int64 remainder (`modInt`): truncating, dividend's sign;
/// zero divisor is `division-by-zero`.
pub fn mod_int(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_bigint(a, "modInt")?;
    let right = require_bigint(b, "modInt")?;
    if right == &BigInt::from(0) {
        return Err(Failure::division_by_zero("int remainder with zero divisor"));
    }
    // num-bigint `%` truncates toward zero exactly like JS bigint `%`.
    narrow_int64(&(left % right), "int64")
}

/// Checked int64 negation (`negateInt`).
pub fn negate_int(a: &Value) -> Result<i64, Failure> {
    let value = require_bigint(a, "negateInt")?;
    narrow_int64(&-value, "int64")
}

/// Checked int64 absolute value (`absInt`).
///
/// Mirrors `a < 0n ? negateInt(a) : int64(a)`. JS numbers compare
/// numerically against `0n` and route to the same branch the TypeScript
/// takes, preserving the branch's error. All other non-bigint inputs are
/// `invalid-construction`; note the TypeScript itself throws engine-native
/// `TypeError`/`SyntaxError` (or routes numeric strings) on those inputs,
/// which is version-dependent, untested upstream, and out of parity scope
/// (recorded in the differential ledger).
pub fn abs_int(a: &Value) -> Result<i64, Failure> {
    let value = require_bigint(a, "absInt")?;
    if value < &BigInt::from(0) {
        negate_int(a)
    } else {
        narrow_int64(value, "int64")
    }
}

/// Total int comparison (`compareInt`): exact for arbitrary bigints.
pub fn compare_int(a: &Value, b: &Value) -> Result<i8, Failure> {
    let left = require_bigint(a, "compareInt")?;
    let right = require_bigint(b, "compareInt")?;
    Ok(if left < right {
        -1
    } else if left > right {
        1
    } else {
        0
    })
}
