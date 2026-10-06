//! Owned money sums (`sumMoney`).
//!
//! Explicit currency validates before elements and the empty sum is that
//! currency's zero; the inferred path needs a nonempty domain and validates
//! the shared head currency once. The minor total narrows once.

use num_bigint::BigInt;

use crate::currency_facts::currency_table_scale;
use crate::failures::{Failure, ValueFailureCode};
use crate::numeric::money::currency_scale;
use crate::representations::numeric::{
    is_money_value, make_money, money_parts_unchecked, narrow_int64, MoneyParts, Value,
};

/// Owned money domain (`sumMoney`).
pub fn sum_money(domain: &[Value], currency: Option<&Value>) -> Result<MoneyParts, Failure> {
    match currency {
        Some(code) => {
            currency_scale(code)?;
            let expected = match code {
                Value::Str(expected) => expected.clone(),
                // Unreachable: `currency_scale` rejects non-strings first.
                _ => return Err(Failure::invalid_construction("currency must be a string")),
            };
            let mut total = BigInt::ZERO;
            for value in domain {
                if !is_money_value(value) {
                    return Err(Failure::invalid_construction(
                        "sumMoney needs money elements",
                    ));
                }
                let parts = money_parts_unchecked(value).expect("guarded money parts");
                if parts.currency != expected {
                    return Err(Failure::new(
                        ValueFailureCode::CurrencyMismatch,
                        "sumMoney amounts must match the explicit currency",
                    ));
                }
                total += parts.minor;
            }
            let narrowed = narrow_int64(&total, "int64")?;
            make_money(
                BigInt::from(narrowed),
                expected.clone(),
                currency_table_scale(&expected),
            )
        }
        None => {
            if domain.is_empty() {
                return Err(Failure::invalid_construction(
                    "sumMoney of an empty domain needs an explicit currency",
                ));
            }
            let head = &domain[0];
            if !is_money_value(head) {
                return Err(Failure::invalid_construction(
                    "sumMoney needs money elements",
                ));
            }
            let head_parts = money_parts_unchecked(head).expect("guarded head parts");
            currency_scale(&Value::Str(head_parts.currency.clone()))?;
            let mut total = BigInt::ZERO;
            for value in domain {
                if !is_money_value(value) {
                    return Err(Failure::invalid_construction(
                        "sumMoney needs money elements",
                    ));
                }
                let parts = money_parts_unchecked(value).expect("guarded money parts");
                if parts.currency != head_parts.currency {
                    return Err(Failure::new(
                        ValueFailureCode::CurrencyMismatch,
                        "sumMoney amounts must share one currency",
                    ));
                }
                total += parts.minor;
            }
            let narrowed = narrow_int64(&total, "int64")?;
            make_money(
                BigInt::from(narrowed),
                head_parts.currency.clone(),
                currency_table_scale(&head_parts.currency),
            )
        }
    }
}
