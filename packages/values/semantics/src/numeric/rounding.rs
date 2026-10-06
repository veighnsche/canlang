//! Half-even rational rounding (`roundRationalHalfEven`, `roundScaledHalfEven`).
//!
//! Rounds the exact rational num/den to an integer, ties to even, symmetric
//! for negatives. Zero denominator is `division-by-zero`.

use num_bigint::BigInt;
use num_traits::Zero;

use crate::failures::Failure;
use crate::representations::numeric::{require_bigint, Value};

/// Round-half-even core shared by decimal and money boundaries.
pub fn round_rational_half_even(num: &Value, den: &Value) -> Result<BigInt, Failure> {
    let num = require_bigint(num, "roundRationalHalfEven")
        .map_err(|_| Failure::invalid_construction("roundRationalHalfEven needs bigint inputs"))?;
    let den = require_bigint(den, "roundRationalHalfEven")
        .map_err(|_| Failure::invalid_construction("roundRationalHalfEven needs bigint inputs"))?;
    round_rational(num, den)
}

/// Unchecked-operand variant for internal callers holding BigInts.
pub fn round_rational(num: &BigInt, den: &BigInt) -> Result<BigInt, Failure> {
    if den.is_zero() {
        return Err(Failure::division_by_zero("rounding with zero denominator"));
    }
    let positive = if den > &BigInt::ZERO {
        num.clone()
    } else {
        -num
    };
    let divisor = if den > &BigInt::ZERO {
        den.clone()
    } else {
        -den
    };
    let negative = positive < BigInt::ZERO;
    let mag = if negative { -positive } else { positive };
    let kept = &mag / &divisor;
    let rest = &mag % &divisor;
    let twice = &rest * 2;
    let mut rounded = kept.clone();
    let two = BigInt::from(2);
    if twice > divisor || (twice == divisor && &kept % &two != BigInt::ZERO) {
        rounded = kept + 1;
    }
    Ok(if negative { -rounded } else { rounded })
}

/// Exact 10^n for n >= 0. Bigint-only; never routes through floats.
pub fn pow10(n: u32) -> BigInt {
    let mut result = BigInt::from(1);
    let ten = BigInt::from(10);
    for _ in 0..n {
        result *= &ten;
    }
    result
}

/// Round-half-even of coef/10^drop to an integer (drop >= 0).
pub fn round_scaled_half_even(coef: &BigInt, drop: u32) -> Result<BigInt, Failure> {
    round_rational(coef, &pow10(drop))
}
