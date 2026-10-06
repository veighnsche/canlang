//! Thin wasm-bindgen adapter over the exact semantics core.
//!
//! A07.1 smoke surface only: [`exact::abi_version`] and
//! [`exact::exact_call`]. Requests and responses reuse the versioned
//! NDJSON operation transport (`transport::exact`), so the binding adds
//! no second operation registry: full entry assembly lands in A07.3.
//!
//! Strings cross the boundary as UTF-8; the core never sees host text
//! directly (all text arrives inside the JSON request payload).

pub mod exact;
pub mod validation;
