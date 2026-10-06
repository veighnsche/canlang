//! Shared owned-domain guards for numeric aggregates.

use crate::failures::Failure;
use crate::representations::numeric::Value;

/// Requires an array domain (`requireArray`): `"{caller} domain must be an array"`.
pub fn require_domain<'a>(value: &'a Value, caller: &str) -> Result<&'a [Value], Failure> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(Failure::invalid_construction(format!(
            "{caller} domain must be an array"
        ))),
    }
}
