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
    /// Well-formed message in the wrong state: unknown kind, resume
    /// with no open token, token mismatch, replay, or second Begin.
    pub const PROTOCOL_VIOLATION: &str = "protocol-violation";
}

/// Semantic-class failure codes: evaluation started and refused.
/// Algorithm lanes (P04+) extend this module; the transport core
/// never emits semantic codes. The P04.4 job refusals reuse the CLI
/// classifications verbatim (`host.ts` `fail(command, code, …)`).
pub mod semantic {
    /// Scaffold marker until P04+ lands job execution.
    pub const UNIMPLEMENTED: &str = "unimplemented";
    /// Host-requested cancel acknowledged; session ends cleanly.
    pub const ABORTED: &str = "aborted";
    /// Artifact unreadable, unparsable, or semantically refused.
    pub const MISSING_PRODUCER: &str = "missing-producer";
    /// CLI usage refusal (missing `--env`, unknown job mode).
    pub const USAGE: &str = "usage";
    /// Descriptor/environment/target reads or fact shapes refused.
    pub const INVALID_DEPLOY_BUNDLE: &str = "invalid-deploy-bundle";
    /// Compatibility reasons refused the deploy.
    pub const INCOMPATIBLE: &str = "incompatible";
    /// Bare deploy without `--yes` (and without `--preview`).
    pub const CONFIRM_REQUIRED: &str = "confirm-required";
    /// Confirmed deploy with a compiler/runtime release mismatch.
    pub const COMPILER_MISMATCH: &str = "compiler-mismatch";
    /// Release lockstep inputs unreadable or drifted.
    pub const RELEASE_DRIFT: &str = "release-drift";
}
