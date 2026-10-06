//! Integration root for `tests/input_validation/` (V03 lane).
//! Child modules stay file-disjoint; only the integrator edits this root.

#[path = "input_validation/conformance_v1.rs"]
mod conformance_v1;
#[path = "input_validation/input.rs"]
mod input;
#[path = "input_validation/validation.rs"]
mod validation;
