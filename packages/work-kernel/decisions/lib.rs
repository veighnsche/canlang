//! Native decision candidates, registered in the package Cargo root.
//!
//! Leaf-local UTF-16, value, error, and row types retain their original
//! semantics. They are deliberately namespaced: registration does not
//! authorize a structural conversion between distinct producer profiles.
//! No production transport, backend selection, or host authority is added.

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
