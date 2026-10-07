//! Language server: stdio JSON-RPC transport plus the LSP session.
//!
//! See [`transport`] for framing/JSON and [`server`] for the session,
//! version tracking and [`server::LanguageAnalysis`] callbacks.

mod output;
pub mod server;
pub mod transport;
mod uri;
