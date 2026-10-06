//! `can-preparation` library root (P04.1): integration tests import
//! the algorithm modules through here; `main.rs` keeps the explicit
//! binary entry and delegates to `job`.

pub mod artifact;
pub mod compatibility;
pub mod failures;
pub mod input;
pub mod job;
pub mod modules;
pub mod plan;
pub mod protocol;
pub mod release;
pub mod render;
pub mod review;
