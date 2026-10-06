//! Shared representations: integer, decimal, money, date and datetime carriers.
//!
//! Mirrors the structural carriers in `int.ts`, `decimal.ts`, `money.ts` and
//! `kinds.ts`. Construction boundaries keep the exact TypeScript codes and
//! messages: malformed inputs are `invalid-construction`, representation
//! breaches at construction are `out-of-range`, and computed results that
//! breach the 38-digit bound are `overflow`.

pub mod numeric;

pub use numeric::{
    DateParts, DatetimeParts, DecimalParts, MoneyParts, Value, DATETIME_MAX_MS, DATETIME_MIN_MS,
    DECIMAL_MAX_SCALE, DECIMAL_MAX_SIGNIFICANT_DIGITS, INT64_MAX, INT64_MIN,
};
