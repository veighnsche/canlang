//! Owned decimal sums (`sumDecimal`).
//!
//! Decimal-only elements; complete validation, then scale selection and a
//! further summing pass; one final 38-digit check. Empty sum is decimal zero.

use num_bigint::BigInt;

use crate::failures::Failure;
use crate::numeric::rounding::pow10;
use crate::representations::numeric::{
    decimal_parts, is_decimal_value, max_scale, significant_digits, DecimalParts, Value,
    DECIMAL_MAX_SIGNIFICANT_DIGITS,
};

/// Owned decimal domain (`sumDecimal`).
pub fn sum_decimal(domain: &[Value]) -> Result<DecimalParts, Failure> {
    for value in domain {
        if !is_decimal_value(value) {
            return Err(Failure::invalid_construction(
                "sumDecimal needs decimal elements",
            ));
        }
    }
    if domain.is_empty() {
        return DecimalParts::make(BigInt::ZERO, 0.0);
    }
    // Seeded at `+0` exactly like `let scale = 0` in TypeScript, so a
    // neg-zero-only domain still sums at `+0` (`Math.max(0, -0)` is `+0`).
    let mut scale: f64 = 0.0;
    for value in domain {
        let parts = decimal_parts(value, "sumDecimal")?;
        scale = max_scale(scale, parts.scale);
    }
    let mut total = BigInt::ZERO;
    for value in domain {
        let parts = decimal_parts(value, "sumDecimal")?;
        total += parts.coef * pow10((scale - parts.scale) as u32);
    }
    if significant_digits(&total) > DECIMAL_MAX_SIGNIFICANT_DIGITS {
        return Err(Failure::overflow(
            "decimal result exceeds 38 significant digits",
        ));
    }
    DecimalParts::make(total, scale)
}
