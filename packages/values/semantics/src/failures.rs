//! Checked-value failure codes and envelope.
//!
//! Mirrors `packages/values/src/errors.ts`: evaluation failures are never
//! business codes. Messages are owned by each operation to preserve the
//! exact TypeScript text.

use std::fmt;

/// Evaluation-failure codes for checked values (never business codes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ValueFailureCode {
    Overflow,
    DivisionByZero,
    Inexact,
    CurrencyMismatch,
    UnknownCurrency,
    InvalidConstruction,
    NonexistentTime,
    FoldRequired,
    OutOfRange,
    LimitExceeded,
}

impl ValueFailureCode {
    /// Wire/stable code string, identical to the TypeScript `ValueFailureCode`.
    pub fn as_str(self) -> &'static str {
        match self {
            ValueFailureCode::Overflow => "overflow",
            ValueFailureCode::DivisionByZero => "division-by-zero",
            ValueFailureCode::Inexact => "inexact",
            ValueFailureCode::CurrencyMismatch => "currency-mismatch",
            ValueFailureCode::UnknownCurrency => "unknown-currency",
            ValueFailureCode::InvalidConstruction => "invalid-construction",
            ValueFailureCode::NonexistentTime => "nonexistent-time",
            ValueFailureCode::FoldRequired => "fold-required",
            ValueFailureCode::OutOfRange => "out-of-range",
            ValueFailureCode::LimitExceeded => "limit-exceeded",
        }
    }
}

impl fmt::Display for ValueFailureCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A checked-value evaluation failure. Distinct from schema violations and
/// from business errors, exactly like TypeScript `ValueError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// Stable failure code.
    pub code: ValueFailureCode,
    /// Human message, byte-identical to the TypeScript message.
    pub message: String,
}

impl Failure {
    pub fn new(code: ValueFailureCode, message: impl Into<String>) -> Self {
        Failure {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_construction(message: impl Into<String>) -> Self {
        Failure::new(ValueFailureCode::InvalidConstruction, message)
    }

    pub fn overflow(message: impl Into<String>) -> Self {
        Failure::new(ValueFailureCode::Overflow, message)
    }

    pub fn out_of_range(message: impl Into<String>) -> Self {
        Failure::new(ValueFailureCode::OutOfRange, message)
    }

    pub fn division_by_zero(message: impl Into<String>) -> Self {
        Failure::new(ValueFailureCode::DivisionByZero, message)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ValueError[{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for Failure {}
