//! Owned int/duration sums (`sumInt`, `sumDuration`).
//!
//! The mathematical total accumulates exactly and narrows to int64 once;
//! intermediate totals may leave int64 while the total fits.

use num_bigint::BigInt;

use crate::failures::Failure;
use crate::representations::numeric::{narrow_int64, Value};

/// Owned int domain with final-only narrowing (`sumInt`).
pub fn sum_int(domain: &[Value]) -> Result<i64, Failure> {
    let mut total = BigInt::ZERO;
    for value in domain {
        match value {
            Value::BigInt(int) => total += int,
            _ => {
                return Err(Failure::invalid_construction("sumInt needs int elements"));
            }
        }
    }
    narrow_int64(&total, "int64")
}

/// Owned duration domain with final-only narrowing (`sumDuration`).
pub fn sum_duration(domain: &[Value]) -> Result<i64, Failure> {
    let mut total = BigInt::ZERO;
    for value in domain {
        match value {
            Value::BigInt(int) => total += int,
            _ => {
                return Err(Failure::invalid_construction(
                    "sumDuration needs duration elements",
                ));
            }
        }
    }
    narrow_int64(&total, "int64")
}
