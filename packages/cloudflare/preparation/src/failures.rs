//! Shared typed failure codes (P03.2).
//!
//! Transport failures (framing/version/limits/lifetime) stay
//! distinguishable from semantic failures (validation/policy
//! refusal), per C03 `transport-contracts.json` envelopes. Every
//! code below is machine-readable and stable within the protocol
//! version; human detail rides alongside, never instead.

// Staged: P03.3 protocol states consume the frame/lifetime codes;
// P04+ algorithm lanes extend `semantic`. Remove when fully wired.
#![allow(dead_code)]

/// Transport-class failure codes: the job never started semantics.
pub mod transport {
    /// Declared protocol name/version is not served.
    pub const VERSION_MISMATCH: &str = "version-mismatch";
    /// Frame tag, length prefix, or payload shape is corrupt.
    pub const FRAME_CORRUPT: &str = "frame-corrupt";
    /// Declared length exceeds the cap (rejected before allocating).
    pub const FRAME_TOO_LARGE: &str = "frame-too-large";
    /// EOF/truncation inside a frame or mid-request.
    pub const TRUNCATED: &str = "truncated";
    /// Tree depth exceeds the admitted limit.
    pub const TREE_TOO_DEEP: &str = "tree-too-deep";
    /// Tree node count exceeds the admitted limit.
    pub const TREE_TOO_MANY_NODES: &str = "tree-too-many-nodes";
    /// Total UTF-16 units exceed the admitted limit.
    pub const TREE_TOO_MANY_UNITS: &str = "tree-too-many-units";
    /// A tagged node has an unknown tag or malformed fields.
    pub const BAD_NODE: &str = "bad-node";
}

/// Semantic-class failure codes: evaluation started and refused.
/// Algorithm lanes (P04+) extend this module; the transport core
/// never emits semantic codes.
pub mod semantic {
    /// Scaffold marker until P04+ lands job execution.
    pub const UNIMPLEMENTED: &str = "unimplemented";
}
