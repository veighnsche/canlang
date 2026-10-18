//! Native decision candidates, registered in the package Cargo root.
//!
//! Leaf-local UTF-16, value, error, and row types retain their original
//! semantics. They are deliberately namespaced: registration does not
//! authorize a structural conversion between distinct producer profiles.
//! No production backend selection or host authority is added. The `call`
//! module shares the registered decision dispatch between the conformance
//! observer and the selected synchronous Wasm transport: one dispatch,
//! two transports, no second implementation of any family.

pub mod call;
pub mod every;
pub mod lifecycle;
pub mod linkage;
pub mod receipt;
pub mod recovery;
pub mod retry;
pub mod rows;

pub(crate) mod numeric_text;
pub(crate) mod utf16_json;

pub(crate) mod uri_component;
