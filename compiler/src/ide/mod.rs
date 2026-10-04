//! IDE queries shared by the LSP server (lane-01 authoring, PR7).
//!
//! [`queries`] answers position-based questions (hover, definition,
//! references, rename, completion, document symbols) over one analyzed
//! document; [`tokens`] provides semantic-token data; [`fixes`]
//! implements the code-action fix contract. All three return LSP-ready
//! byte spans and stay silent on anything the analysis did not
//! resolve: empty results, never errors, never guesses.

pub mod fixes;
pub mod queries;
pub mod tokens;
