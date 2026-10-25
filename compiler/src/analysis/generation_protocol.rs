//! BGI-03: version-1 `can gen` JSON request/result/event protocol and
//! the MCP context/content-submission contract.
//!
//! This module owns the common admission/output contract every
//! generation operation shares: strict request validation (schema,
//! typed operations, exactly-one instruction carrier), the final
//! result envelope plus JSONL progress events, deterministic
//! error/exit semantics, and the small MCP context/submission shapes
//! derived from checked descriptors (server-issued targets/roles
//! only; no caller paths, no second manifest).
//!
//! Operation handlers join through BGI-05/BGI-12; this task owns
//! their common admission once. The Node generation host mirrors
//! these shapes in `packages/cloudflare/src/generation/protocol.ts`.

use std::collections::BTreeMap;

use super::generation_config::GEN_PROTOCOL_VERSION;

/// All typed v1 operations, with their wire names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenOperation {
    /// Provider check: adapter availability, MCP/write enforcement,
    /// controls, and actionable auth/model issues; never generates.
    Doctor,
    /// Unit/source association report with current/candidate paths.
    Status,
    /// One unit's association, contracts, and effective recipe.
    Inspect,
    /// Explicit source location/revision to ID reconciliation.
    Bind,
    /// Explicit preparation (`prepare`) or fresh generation (`fresh`).
    Generate,
    /// Candidate from current implementation plus one instruction.
    Refine,
    /// Fresh full active-app regeneration without per-prompt selectors.
    Retry,
    /// Continue one supported recorded session.
    Resume,
    /// Machine-consumable candidate/current differences.
    Diff,
    /// Optional rendered preview artifacts.
    Preview,
    /// Interface/contract/target checks for candidates or repairs.
    Validate,
    /// Reconcile directly repaired files to current inputs.
    Adopt,
    /// Conditional promotion under preservation checks.
    Accept,
    /// Best-effort stop; late results cannot promote.
    Cancel,
    /// Discard pending work; current files stay intact.
    Reset,
    /// Restore an explicitly selected historical revision.
    Rollback,
    /// Acquire an edit lease for exact unit/source paths (BGI-04).
    EditBegin,
    /// Release an edit lease token (BGI-04).
    EditEnd,
    /// Recover an interrupted lease after its writer stopped (BGI-04).
    LeaseRecover,
}

impl GenOperation {
    /// Wire name used in requests and envelopes.
    pub fn as_str(&self) -> &'static str {
        match self {
            GenOperation::Doctor => "doctor",
            GenOperation::Status => "status",
            GenOperation::Inspect => "inspect",
            GenOperation::Bind => "bind",
            GenOperation::Generate => "generate",
            GenOperation::Refine => "refine",
            GenOperation::Retry => "retry",
            GenOperation::Resume => "resume",
            GenOperation::Diff => "diff",
            GenOperation::Preview => "preview",
            GenOperation::Validate => "validate",
            GenOperation::Adopt => "adopt",
            GenOperation::Accept => "accept",
            GenOperation::Cancel => "cancel",
            GenOperation::Reset => "reset",
            GenOperation::Rollback => "rollback",
            GenOperation::EditBegin => "edit.begin",
            GenOperation::EditEnd => "edit.end",
            GenOperation::LeaseRecover => "lease.recover",
        }
    }

    /// Parse a wire name; unknown operations diagnose.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "doctor" => Some(GenOperation::Doctor),
            "status" => Some(GenOperation::Status),
            "inspect" => Some(GenOperation::Inspect),
            "bind" => Some(GenOperation::Bind),
            "generate" => Some(GenOperation::Generate),
            "refine" => Some(GenOperation::Refine),
            "retry" => Some(GenOperation::Retry),
            "resume" => Some(GenOperation::Resume),
            "diff" => Some(GenOperation::Diff),
            "preview" => Some(GenOperation::Preview),
            "validate" => Some(GenOperation::Validate),
            "adopt" => Some(GenOperation::Adopt),
            "accept" => Some(GenOperation::Accept),
            "cancel" => Some(GenOperation::Cancel),
            "reset" => Some(GenOperation::Reset),
            "rollback" => Some(GenOperation::Rollback),
            "edit.begin" => Some(GenOperation::EditBegin),
            "edit.end" => Some(GenOperation::EditEnd),
            "lease.recover" => Some(GenOperation::LeaseRecover),
            _ => None,
        }
    }

    /// Every operation in wire order (for help and coverage).
    pub const ALL: &[GenOperation] = &[
        GenOperation::Doctor,
        GenOperation::Status,
        GenOperation::Inspect,
        GenOperation::Bind,
        GenOperation::Generate,
        GenOperation::Refine,
        GenOperation::Retry,
        GenOperation::Resume,
        GenOperation::Diff,
        GenOperation::Preview,
        GenOperation::Validate,
        GenOperation::Adopt,
        GenOperation::Accept,
        GenOperation::Cancel,
        GenOperation::Reset,
        GenOperation::Rollback,
        GenOperation::EditBegin,
        GenOperation::EditEnd,
        GenOperation::LeaseRecover,
    ];
}

/// Typed admission failure with its process exit code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    /// Process exit code (0/2/3/4/5/6 per BGEN14).
    pub exit: i32,
    /// Machine-readable code (`unknown-operation`, ...).
    pub code: &'static str,
    /// Human-actionable detail naming the value and the fix.
    pub message: String,
}

impl ProtocolError {
    /// Admission failure exiting 2 (invalid request/config/selection).
    pub fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            exit: crate::exit::TOOL_FAILURE,
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ProtocolError {}

/// Validated request header: every v1 request carries protocol
/// version 1, a non-empty caller request id, and a known operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHeader {
    /// Caller request id (idempotency key; BGI-05/12 stores it).
    pub request_id: String,
    /// Validated operation.
    pub operation: GenOperation,
}

/// Declares one operation params struct with strict unknown-field
/// rejection. The `+ recipe` form appends the shared flat
/// recipe-resolution fields (identical for every recipe-bearing
/// operation) plus an [`RunOverrides`] accessor. A macro keeps the
/// shared fields byte-identical across operations: serde's
/// `deny_unknown_fields` cannot combine with `flatten`, so the
/// fields are expanded into each struct instead.
macro_rules! gen_params {
    ($name:ident { $($( #[$meta:meta] )* $field:ident: $ty:ty,)* }) => {
        #[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            $($( #[$meta] )* pub $field: $ty,)*
        }
    };
    ($name:ident { $($( #[$meta:meta] )* $field:ident: $ty:ty,)* } + recipe) => {
        #[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            $($( #[$meta] )* pub $field: $ty,)*
            /// Replacement settings file (relative paths resolve at `root`).
            pub settings: Option<String>,
            /// Explicit run profile selecting a complete pair.
            pub profile: Option<String>,
            /// Explicit runner (requires an explicit model in the same run).
            pub runner: Option<String>,
            /// Explicit model for the effective runner.
            pub model: Option<String>,
            /// Explicit finite attempt bound.
            pub max_attempts: Option<u32>,
            /// Explicit finite per-execution timeout.
            pub timeout_seconds: Option<u32>,
            /// Explicit native map replacing the recipe table wholesale.
            pub native: Option<BTreeMap<String, serde_json::Value>>,
        }

        impl $name {
            /// Explicit per-run overrides carried by this request.
            pub fn overrides(&self) -> super::generation_config::RunOverrides {
                super::generation_config::RunOverrides {
                    profile: self.profile.clone(),
                    runner: self.runner.clone(),
                    model: self.model.clone(),
                    max_attempts: self.max_attempts,
                    timeout_seconds: self.timeout_seconds,
                    native: self.native.clone(),
                }
            }
        }
    };
}

/// Validated per-operation parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenParams {
    /// Provider check with optional recipe selectors.
    Doctor(DoctorParams),
    /// Association report over explicit sources.
    Status(StatusParams),
    /// One unit plus its effective recipe.
    Inspect(InspectParams),
    /// Explicit reconciliation of one inspected span.
    Bind(BindParams),
    /// Explicit preparation or fresh generation.
    Generate(GenerateParams),
    /// Candidate from current code plus one instruction carrier.
    Refine(RefineParams),
    /// Fresh full active-app regeneration over explicit sources.
    Retry(RetryParams),
    /// Continue one recorded session.
    Resume(ResumeParams),
    /// Machine diffs for one unit.
    Diff(DiffParams),
    /// Rendered preview for one unit.
    Preview(PreviewParams),
    /// Checks for one candidate or repaired files.
    Validate(ValidateParams),
    /// Reconcile repaired files to one unit.
    Adopt(AdoptParams),
    /// Conditional promotion of one unit or attempt scope.
    Accept(AcceptParams),
    /// Stop one session or request.
    Cancel(CancelParams),
    /// Discard one pending scope.
    Reset(ResetParams),
    /// Restore one explicit historical revision.
    Rollback(RollbackParams),
    /// Acquire an edit lease (BGI-04).
    EditBegin(EditBeginParams),
    /// Release an edit lease token (BGI-04).
    EditEnd(EditEndParams),
    /// Recover one interrupted lease (BGI-04).
    LeaseRecover(LeaseRecoverParams),
}

gen_params!(DoctorParams {
    /// Project root (settings discovery; default `.`).
    root: Option<String>,
} + recipe);

gen_params!(StatusParams {
    /// Project root for `can.generated/` and candidate paths.
    root: String,
    /// Explicit source files to discover (non-empty).
    files: Vec<String>,
});

gen_params!(InspectParams {
    /// Project root.
    root: String,
    /// Saved unit id selector (xor the source span).
    unit_id: Option<String>,
    /// Source span file selector (with `start`/`end`).
    file: Option<String>,
    /// Source span start byte (with `file`/`end`).
    start: Option<u32>,
    /// Source span end byte (with `file`/`start`).
    end: Option<u32>,
} + recipe);

gen_params!(BindParams {
    /// Project root.
    root: String,
    /// Inspected source file.
    file: String,
    /// Inspected span start byte.
    start: u32,
    /// Inspected span end byte.
    end: u32,
    /// Inspected source revision (stale revisions refuse).
    revision: String,
    /// Existing unit id or `new`.
    unit: String,
    /// Fork this unit's complete current group when allocating `unit: new`.
    copy_from: Option<String>,
});

gen_params!(GenerateParams {
    /// Project root.
    root: String,
    /// Explicit source scope (xor `unit_ids`; one is required).
    files: Option<Vec<String>>,
    /// Explicit unit scope (xor `files`; one is required).
    unit_ids: Option<Vec<String>>,
    /// `prepare` (current code is a baseline) or `fresh` (source intent only).
    mode: String,
    /// Compose capture, submission, validation, and conditional
    /// promotion without weakening checks (joins BGI-12).
    accept: Option<bool>,
} + recipe);

gen_params!(RefineParams {
    /// Project root.
    root: String,
    /// Saved unit id to refine.
    unit_id: String,
    /// Inline instruction text (exactly one carrier is required).
    instruction: Option<String>,
    /// Instruction file path (exactly one carrier is required).
    instruction_file: Option<String>,
    /// Read the instruction from dispatcher stdin (exactly one
    /// carrier is required; only with `--request FILE`).
    instruction_stdin: Option<bool>,
    /// Compose capture, submission, validation, and conditional
    /// promotion without weakening checks (joins BGI-12).
    accept: Option<bool>,
} + recipe);

gen_params!(RetryParams {
    /// Project root.
    root: String,
    /// Explicit active-app source closure (non-empty; unrelated apps
    /// stay outside scope).
    files: Vec<String>,
    /// Compose capture, submission, validation, and conditional
    /// promotion without weakening checks (joins BGI-12).
    accept: Option<bool>,
} + recipe);

gen_params!(ResumeParams {
    /// Project root.
    root: String,
    /// Recorded session id to continue.
    session_id: String,
});

gen_params!(DiffParams {
    /// Project root.
    root: String,
    /// Saved unit id to diff.
    unit_id: String,
    /// Attempt scope (default: the latest pending attempt).
    attempt: Option<String>,
});

gen_params!(PreviewParams {
    /// Project root.
    root: String,
    /// Saved unit id to preview.
    unit_id: String,
});

gen_params!(ValidateParams {
    /// Project root.
    root: String,
    /// Candidate unit scope (xor `files`; one is required).
    unit_id: Option<String>,
    /// Directly repaired files scope (xor `unit_id`; one is required).
    files: Option<Vec<String>>,
});

gen_params!(AdoptParams {
    /// Project root.
    root: String,
    /// Saved unit id receiving the repaired files.
    unit_id: String,
    /// Directly repaired files to reconcile (non-empty).
    files: Vec<String>,
});

gen_params!(AcceptParams {
    /// Project root.
    root: String,
    /// Unit scope (xor `attempt`; one is required).
    unit_id: Option<String>,
    /// Full-run attempt scope (xor `unit_id`; one is required).
    attempt: Option<String>,
});

gen_params!(CancelParams {
    /// Project root.
    root: String,
    /// Session scope (xor `request`; one is required).
    session_id: Option<String>,
    /// Request scope: id of the request to cancel (xor `session_id`;
    /// one is required). Named `request` so it never collides with
    /// the envelope's own `request_id` header.
    request: Option<String>,
});

gen_params!(ResetParams {
    /// Project root.
    root: String,
    /// Unit scope (exactly one selector is required).
    unit_id: Option<String>,
    /// Attempt scope (exactly one selector is required).
    attempt: Option<String>,
    /// Session scope (exactly one selector is required).
    session_id: Option<String>,
});

gen_params!(RollbackParams {
    /// Project root.
    root: String,
    /// Saved unit id to restore.
    unit_id: String,
    /// Explicit historical revision to restore.
    revision: String,
});

gen_params!(EditBeginParams {
    /// Project root.
    root: String,
    /// Unit scope (at least one of `unit_id`/`paths` is required).
    unit_id: Option<String>,
    /// Exact source paths (at least one of `unit_id`/`paths` is required).
    paths: Option<Vec<String>>,
});

gen_params!(EditEndParams {
    /// Project root.
    root: String,
    /// Lease token to release.
    token: String,
});

gen_params!(LeaseRecoverParams {
    /// Project root.
    root: String,
    /// Interrupted lease to recover.
    lease: String,
});

/// One fully validated v1 request: header plus typed parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRequest {
    /// Request id and operation.
    pub header: RequestHeader,
    /// Validated per-operation parameters.
    pub params: GenParams,
}

/// Parse and validate one v1 request document: JSON object, protocol
/// version 1, non-empty request id, known operation, strictly known
/// per-operation fields, then per-operation semantic checks
/// (required selectors, exclusive instruction carriers, modes).
pub fn parse_request(text: &str) -> Result<ValidatedRequest, ProtocolError> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|err| {
        ProtocolError::invalid("invalid-json", format!("request is not valid JSON: {err}"))
    })?;
    let serde_json::Value::Object(mut map) = value else {
        return Err(ProtocolError::invalid(
            "invalid-json",
            "request must be a JSON object with version, request_id, and operation",
        ));
    };
    let version = map.remove("version").ok_or_else(|| {
        ProtocolError::invalid(
            "missing-param",
            "request misses `version`; the v1 dispatcher requires `\"version\": 1`",
        )
    })?;
    if version != serde_json::json!(GEN_PROTOCOL_VERSION) {
        return Err(ProtocolError::invalid(
            "unsupported-version",
            format!(
                "unsupported request version {version}; this dispatcher implements v{GEN_PROTOCOL_VERSION}"
            ),
        ));
    }
    let request_id = map.remove("request_id").ok_or_else(|| {
        ProtocolError::invalid(
            "missing-param",
            "request misses `request_id`; every v1 request carries a non-empty caller id",
        )
    })?;
    let serde_json::Value::String(request_id) = request_id else {
        return Err(ProtocolError::invalid(
            "invalid-param",
            "request `request_id` must be a non-empty string",
        ));
    };
    if request_id.trim().is_empty() {
        return Err(ProtocolError::invalid(
            "invalid-param",
            "request `request_id` must be a non-empty string",
        ));
    }
    let operation = map.remove("operation").ok_or_else(|| {
        ProtocolError::invalid(
            "missing-param",
            "request misses `operation`; want one of the typed v1 operations",
        )
    })?;
    let serde_json::Value::String(operation) = operation else {
        return Err(ProtocolError::invalid(
            "invalid-param",
            "request `operation` must be a string operation name",
        ));
    };
    let Some(operation) = GenOperation::parse(&operation) else {
        let known: Vec<&str> = GenOperation::ALL.iter().map(GenOperation::as_str).collect();
        return Err(ProtocolError::invalid(
            "unknown-operation",
            format!(
                "unknown operation `{operation}`; supported operations: {}",
                known.join(", ")
            ),
        ));
    };
    let rest = serde_json::Value::Object(map);
    let params = parse_params(operation, rest)?;
    Ok(ValidatedRequest {
        header: RequestHeader {
            request_id,
            operation,
        },
        params,
    })
}

fn parse_params(
    operation: GenOperation,
    rest: serde_json::Value,
) -> Result<GenParams, ProtocolError> {
    let name = operation.as_str();
    match operation {
        GenOperation::Doctor => parse_doctor_params(name, rest),
        GenOperation::Status => parse_status_params(name, rest),
        GenOperation::Inspect => parse_inspect_params(name, rest),
        GenOperation::Bind => parse_bind_params(name, rest),
        GenOperation::Generate => parse_generate_params(name, rest),
        GenOperation::Refine => parse_refine_params(name, rest),
        GenOperation::Retry => parse_retry_params(name, rest),
        GenOperation::Resume => parse_resume_params(name, rest),
        GenOperation::Diff => parse_diff_params(name, rest),
        GenOperation::Preview => parse_preview_params(name, rest),
        GenOperation::Validate => parse_validate_params(name, rest),
        GenOperation::Adopt => parse_adopt_params(name, rest),
        GenOperation::Accept => parse_accept_params(name, rest),
        GenOperation::Cancel => parse_cancel_params(name, rest),
        GenOperation::Reset => parse_reset_params(name, rest),
        GenOperation::Rollback => parse_rollback_params(name, rest),
        GenOperation::EditBegin => parse_edit_begin_params(name, rest),
        GenOperation::EditEnd => parse_edit_end_params(name, rest),
        GenOperation::LeaseRecover => parse_lease_recover_params(name, rest),
    }
}

fn reject_param(name: &str, err: serde_json::Error) -> ProtocolError {
    let message = err.to_string();
    // Serde reports unknown fields as `unknown field ...`; keep
    // that typed, and shape every other failure as invalid-param.
    if message.starts_with("unknown field") {
        ProtocolError::invalid("unknown-field", format!("operation `{name}`: {message}"))
    } else {
        ProtocolError::invalid("invalid-param", format!("operation `{name}`: {message}"))
    }
}

fn decode_params<T>(name: &str, rest: serde_json::Value) -> Result<T, ProtocolError>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_value(rest).map_err(|err| reject_param(name, err))
}

fn parse_doctor_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: DoctorParams = decode_params(name, rest)?;
    if let Some(root) = &params.root {
        require_text(name, "root", root)?;
    }
    check_run_limits(name, params.max_attempts, params.timeout_seconds)?;
    Ok(GenParams::Doctor(params))
}

fn parse_status_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: StatusParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_non_empty(name, "files", &params.files)?;
    Ok(GenParams::Status(params))
}

fn parse_inspect_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: InspectParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    if let Some(unit_id) = &params.unit_id {
        require_text(name, "unit_id", unit_id)?;
    }
    if let Some(file) = &params.file {
        require_text(name, "file", file)?;
    }
    check_inspect_selector(name, &params)?;
    check_run_limits(name, params.max_attempts, params.timeout_seconds)?;
    Ok(GenParams::Inspect(params))
}

fn check_inspect_selector(name: &str, params: &InspectParams) -> Result<(), ProtocolError> {
    let by_id = params.unit_id.is_some();
    let by_span = params.file.is_some() || params.start.is_some() || params.end.is_some();
    if by_id == by_span {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!(
                "operation `{name}` needs exactly one selector: `unit_id`, or `file` with `start`/`end`"
            ),
        ));
    }
    if by_span && (params.file.is_none() || params.start.is_none() || params.end.is_none()) {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` needs `file`, `start`, and `end` together"),
        ));
    }
    if let (Some(start), Some(end)) = (params.start, params.end)
        && start > end
    {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` needs span START<=END, got {start}..{end}"),
        ));
    }
    Ok(())
}

fn parse_bind_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: BindParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "file", &params.file)?;
    require_text(name, "revision", &params.revision)?;
    require_text(name, "unit", &params.unit)?;
    if let Some(copy_from) = &params.copy_from {
        require_text(name, "copy_from", copy_from)?;
        if params.unit != "new" {
            return Err(ProtocolError::invalid(
                "invalid-param",
                "bind `copy_from` requires `unit: new`",
            ));
        }
    }
    if params.start > params.end {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!(
                "operation `{name}` needs span START<=END, got {}..{}",
                params.start, params.end,
            ),
        ));
    }
    Ok(GenParams::Bind(params))
}

fn parse_generate_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: GenerateParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    match (&params.files, &params.unit_ids) {
        (Some(files), None) => require_non_empty(name, "files", files)?,
        (None, Some(ids)) => require_non_empty(name, "unit_ids", ids)?,
        _ => {
            return Err(ProtocolError::invalid(
                "invalid-param",
                format!("operation `{name}` needs exactly one scope: `files` or `unit_ids`"),
            ));
        }
    }
    if params.mode != "prepare" && params.mode != "fresh" {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!(
                "operation `{name}` needs `mode` \"prepare\" or \"fresh\", got {:?}",
                params.mode,
            ),
        ));
    }
    check_run_limits(name, params.max_attempts, params.timeout_seconds)?;
    Ok(GenParams::Generate(params))
}

fn parse_refine_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: RefineParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "unit_id", &params.unit_id)?;
    check_instruction_carrier(name, &params)?;
    check_run_limits(name, params.max_attempts, params.timeout_seconds)?;
    Ok(GenParams::Refine(params))
}

fn parse_retry_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: RetryParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_non_empty(name, "files", &params.files)?;
    check_run_limits(name, params.max_attempts, params.timeout_seconds)?;
    Ok(GenParams::Retry(params))
}

fn parse_resume_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: ResumeParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "session_id", &params.session_id)?;
    Ok(GenParams::Resume(params))
}

fn parse_diff_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: DiffParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "unit_id", &params.unit_id)?;
    Ok(GenParams::Diff(params))
}

fn parse_preview_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: PreviewParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "unit_id", &params.unit_id)?;
    Ok(GenParams::Preview(params))
}

fn parse_validate_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: ValidateParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    if let Some(unit_id) = &params.unit_id {
        require_text(name, "unit_id", unit_id)?;
    }
    match (&params.unit_id, &params.files) {
        (Some(_), None) => {}
        (None, Some(files)) => require_non_empty(name, "files", files)?,
        _ => {
            return Err(ProtocolError::invalid(
                "invalid-param",
                format!("operation `{name}` needs exactly one scope: `unit_id` or `files`"),
            ));
        }
    }
    Ok(GenParams::Validate(params))
}

fn parse_adopt_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: AdoptParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "unit_id", &params.unit_id)?;
    require_non_empty(name, "files", &params.files)?;
    Ok(GenParams::Adopt(params))
}

fn parse_accept_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: AcceptParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    if let Some(unit_id) = &params.unit_id {
        require_text(name, "unit_id", unit_id)?;
    }
    if let Some(attempt) = &params.attempt {
        require_text(name, "attempt", attempt)?;
    }
    if params.unit_id.is_some() == params.attempt.is_some() {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` needs exactly one scope: `unit_id` or `attempt`"),
        ));
    }
    Ok(GenParams::Accept(params))
}

fn parse_cancel_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: CancelParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    if let Some(session_id) = &params.session_id {
        require_text(name, "session_id", session_id)?;
    }
    if let Some(request) = &params.request {
        require_text(name, "request", request)?;
    }
    if params.session_id.is_some() == params.request.is_some() {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` needs exactly one scope: `session_id` or `request`"),
        ));
    }
    Ok(GenParams::Cancel(params))
}

fn parse_reset_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: ResetParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    if let Some(unit_id) = &params.unit_id {
        require_text(name, "unit_id", unit_id)?;
    }
    if let Some(attempt) = &params.attempt {
        require_text(name, "attempt", attempt)?;
    }
    if let Some(session_id) = &params.session_id {
        require_text(name, "session_id", session_id)?;
    }
    let selectors = params.unit_id.is_some() as u8
        + params.attempt.is_some() as u8
        + params.session_id.is_some() as u8;
    if selectors != 1 {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!(
                "operation `{name}` needs exactly one scope: `unit_id`, `attempt`, or `session_id`"
            ),
        ));
    }
    Ok(GenParams::Reset(params))
}

fn parse_rollback_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: RollbackParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "unit_id", &params.unit_id)?;
    require_text(name, "revision", &params.revision)?;
    Ok(GenParams::Rollback(params))
}

fn parse_edit_begin_params(
    name: &str,
    rest: serde_json::Value,
) -> Result<GenParams, ProtocolError> {
    let params: EditBeginParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    if let Some(unit_id) = &params.unit_id {
        require_text(name, "unit_id", unit_id)?;
    }
    if params.unit_id.is_none() && params.paths.is_none() {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` needs `unit_id` and/or `paths`"),
        ));
    }
    if let Some(paths) = &params.paths {
        require_non_empty(name, "paths", paths)?;
    }
    Ok(GenParams::EditBegin(params))
}

fn parse_edit_end_params(name: &str, rest: serde_json::Value) -> Result<GenParams, ProtocolError> {
    let params: EditEndParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "token", &params.token)?;
    Ok(GenParams::EditEnd(params))
}

fn parse_lease_recover_params(
    name: &str,
    rest: serde_json::Value,
) -> Result<GenParams, ProtocolError> {
    let params: LeaseRecoverParams = decode_params(name, rest)?;
    require_text(name, "root", &params.root)?;
    require_text(name, "lease", &params.lease)?;
    Ok(GenParams::LeaseRecover(params))
}

fn require_text(name: &str, key: &str, value: &str) -> Result<(), ProtocolError> {
    if value.is_empty() {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` needs a non-empty `{key}`"),
        ));
    }
    Ok(())
}

/// Per-run limits share the TOML positive-finite domain: zero is
/// outside it and refuses at admission, before any recipe
/// construction or runner launch. Serde already rejects
/// non-integers, negatives, and overflow; only zero slips through.
fn check_run_limits(
    name: &str,
    max_attempts: Option<u32>,
    timeout_seconds: Option<u32>,
) -> Result<(), ProtocolError> {
    for (key, value) in [
        ("max_attempts", max_attempts),
        ("timeout_seconds", timeout_seconds),
    ] {
        if value == Some(0) {
            return Err(ProtocolError::invalid(
                "invalid-param",
                format!("operation `{name}`: `{key}` must be a positive finite integer"),
            ));
        }
    }
    Ok(())
}

fn require_non_empty(name: &str, key: &str, values: &[String]) -> Result<(), ProtocolError> {
    if values.is_empty() {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` needs a non-empty `{key}` list"),
        ));
    }
    if values.iter().any(|value| value.is_empty()) {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` rejects empty entries in `{key}`"),
        ));
    }
    Ok(())
}

/// Exactly one instruction carrier for `refine`: inline `instruction`
/// text, an `instruction_file` path, or `instruction_stdin` (which
/// the dispatcher honors only when the request itself arrived via
/// `--request FILE`, since one stdin stream cannot carry both).
fn check_instruction_carrier(name: &str, params: &RefineParams) -> Result<(), ProtocolError> {
    let carriers = params.instruction.is_some() as u8
        + params.instruction_file.is_some() as u8
        + params.instruction_stdin.unwrap_or(false) as u8;
    if carriers != 1 {
        return Err(ProtocolError::invalid(
            "exclusive-carrier",
            format!(
                "operation `{name}` needs exactly one instruction carrier: `instruction`, `instruction_file`, or `instruction_stdin`"
            ),
        ));
    }
    if let Some(text) = &params.instruction
        && text.is_empty()
    {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` rejects an empty inline `instruction`"),
        ));
    }
    if let Some(path) = &params.instruction_file
        && path.is_empty()
    {
        return Err(ProtocolError::invalid(
            "invalid-param",
            format!("operation `{name}` rejects an empty `instruction_file` path"),
        ));
    }
    Ok(())
}

/// Which carrier a validated `refine` request selected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstructionCarrier {
    /// Inline instruction text.
    Text(String),
    /// Instruction file path (resolved against the request root).
    File(String),
    /// Instruction from dispatcher stdin (`--request FILE` only).
    Stdin,
}

impl RefineParams {
    /// The exactly-one carrier admitted by validation.
    pub fn carrier(&self) -> InstructionCarrier {
        if let Some(text) = &self.instruction {
            InstructionCarrier::Text(text.clone())
        } else if let Some(path) = &self.instruction_file {
            InstructionCarrier::File(path.clone())
        } else {
            InstructionCarrier::Stdin
        }
    }
}

/// Build the one final JSON result envelope for a successful
/// operation: version, request, operation, `ok: true`, the
/// operation `state`, its payload fields, and bounded next actions.
pub fn ok_envelope(
    header: &RequestHeader,
    state: &str,
    mut payload: serde_json::Map<String, serde_json::Value>,
    next: Vec<String>,
) -> String {
    let mut envelope = serde_json::Map::new();
    envelope.insert(
        "version".to_string(),
        serde_json::json!(GEN_PROTOCOL_VERSION),
    );
    envelope.insert(
        "request_id".to_string(),
        serde_json::Value::String(header.request_id.clone()),
    );
    envelope.insert(
        "operation".to_string(),
        serde_json::Value::String(header.operation.as_str().to_string()),
    );
    envelope.insert("ok".to_string(), serde_json::Value::Bool(true));
    envelope.insert(
        "state".to_string(),
        serde_json::Value::String(state.to_string()),
    );
    envelope.append(&mut payload);
    envelope.insert(
        "next".to_string(),
        serde_json::Value::Array(next.into_iter().map(serde_json::Value::String).collect()),
    );
    format!("{}\n", serde_json::Value::Object(envelope))
}

/// Build the one final JSON result envelope for a failed operation:
/// version, request, operation, `ok: false`, the structured error,
/// and bounded next actions. The header fields echo the request when
/// they parsed; unparseable headers use empty/unknown markers, never
/// invented ids.
pub fn error_envelope(
    request_id: &str,
    operation: &str,
    code: &str,
    message: &str,
    next: Vec<String>,
) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "version": GEN_PROTOCOL_VERSION,
            "request_id": request_id,
            "operation": operation,
            "ok": false,
            "state": "error",
            "error": {"code": code, "message": message},
            "next": next,
        })
    )
}

/// Build one optional JSONL progress event. Progress goes to stderr
/// only, so stdout always carries exactly the final envelope; the
/// stream ends with that envelope. BGI-03 admission is synchronous
/// and emits no progress itself; multi-phase handlers (BGI-05+)
/// stream these first.
pub fn progress_event(request_id: &str, operation: &str, phase: &str, detail: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "version": GEN_PROTOCOL_VERSION,
            "request_id": request_id,
            "operation": operation,
            "event": "progress",
            "phase": phase,
            "detail": detail,
        })
    )
}

/// MCP tool returning immutable checked context and server-issued
/// allowed output handles/roles (no secrets, no paths).
pub const MCP_CONTEXT_TOOL: &str = "generation_context";
/// MCP tool accepting batches of `{target, role, content}` against
/// issued handles; the host writes candidates and reports status.
pub const MCP_SUBMIT_TOOL: &str = "generation_submit";

/// Output role admitted for one server-issued target. Roles come
/// from the checked unit contract, never from caller invention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpRole {
    /// Server implementation (`server.js`, workerd target).
    Server,
    /// Browser interaction code (`browser.js`).
    Browser,
    /// Scoped style (`style.css`).
    Style,
    /// Owned binary asset (checked base64 payload).
    Asset,
    /// Compiler-readable owning declarations (`contributions.can`).
    Contributions,
}

impl McpRole {
    /// Wire name used in context handles and submissions.
    pub fn as_str(&self) -> &'static str {
        match self {
            McpRole::Server => "server",
            McpRole::Browser => "browser",
            McpRole::Style => "style",
            McpRole::Asset => "asset",
            McpRole::Contributions => "contributions",
        }
    }

    /// Parse a wire name; unknown roles diagnose.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "server" => Some(McpRole::Server),
            "browser" => Some(McpRole::Browser),
            "style" => Some(McpRole::Style),
            "asset" => Some(McpRole::Asset),
            "contributions" => Some(McpRole::Contributions),
            _ => None,
        }
    }
}

/// One server-issued allowed output target: an opaque session-bound
/// handle plus its admitted role. Handles are internal
/// associations, not authored prompt names and never filesystem
/// paths; the host alone maps them to candidate placement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedTarget {
    /// Opaque session-bound handle (grammar `[A-Za-z0-9_-]{1,128}`).
    pub handle: String,
    /// The one role admitted for this handle.
    pub role: McpRole,
    /// Unit kind this target serves (descriptor-derived).
    pub kind: String,
    /// Server-chosen logical filename (the host maps it to paths).
    pub filename: String,
}

/// Immutable checked context for one captured attempt, as served by
/// `generation_context`. No secrets, no physical paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationContext {
    /// Host-bound MCP session id.
    pub session: String,
    /// Captured attempt id.
    pub attempt: String,
    /// Digest of the captured source/contract closure.
    pub source_digest: String,
    /// Server-issued allowed output handles/roles.
    pub allowed: Vec<AllowedTarget>,
    /// Frozen source/ABI/theme instructions owned by the captured host context.
    pub instructions: Option<String>,
}

/// One `{target, role, content}` submission entry. Content is UTF-8
/// text or a checked base64 asset payload, never a file reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmissionEntry {
    /// Issued handle being submitted (never a path).
    pub target: String,
    /// Role claimed for the handle (must match issuance).
    pub role: String,
    /// UTF-8 code/text content (xor `content_base64`).
    pub content_text: Option<String>,
    /// Checked base64 asset payload (xor `content_text`).
    pub content_base64: Option<String>,
}

/// Typed MCP contract failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpError {
    /// Machine-readable code (`unknown-target`, `role-mismatch`, ...).
    pub code: &'static str,
    /// Human-actionable detail.
    pub message: String,
}

impl McpError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for McpError {}

/// Admitted (role, logical filename) outputs per identity-carrying
/// unit kind, derived from checked descriptors. Views admit server,
/// browser, style, and asset outputs; styles (including view-root
/// inline styles) admit style and asset; traits admit checked contributions
/// and pure custom keywords admit only their server implementation.
/// Asset filenames stay
/// server-issued: callers never choose them.
pub fn allowed_outputs_for(
    kind: super::generation_intake::UnitKind,
) -> &'static [(McpRole, &'static str)] {
    use super::generation_intake::UnitKind;
    match kind {
        UnitKind::Style | UnitKind::StyleInline | UnitKind::ViewStyleInline => {
            &[(McpRole::Style, "style.css"), (McpRole::Asset, "asset.bin")]
        }
        UnitKind::View => &[
            (McpRole::Server, "server.js"),
            (McpRole::Browser, "browser.js"),
            (McpRole::Style, "style.css"),
            (McpRole::Asset, "asset.bin"),
        ],
        UnitKind::NamedTrait | UnitKind::InlineTrait => {
            &[(McpRole::Contributions, "contributions.can")]
        }
        UnitKind::Keyword => &[(McpRole::Server, "server.js")],
    }
}

/// Opaque handle grammar: 1..=128 ASCII letters, digits, `_`, `-`.
/// Anything else (including every path shape) is not a handle.
pub fn handle_grammar_valid(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 128
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Validate one `generation_submit` batch against the issued
/// context: the session must match, the batch must be non-empty,
/// every target must be an issued handle (path-like targets refuse
/// as arbitrary paths, never as missing handles), roles must match
/// issuance, each entry carries exactly one well-formed content
/// payload, and no target repeats within the batch. Returns the
/// matched allowed targets in batch order. Cross-batch duplicate
/// detection is server state owned by the BGI-05 host.
pub fn validate_submission_batch<'ctx>(
    context: &'ctx GenerationContext,
    session: &str,
    batch: &[SubmissionEntry],
) -> Result<Vec<&'ctx AllowedTarget>, McpError> {
    if session != context.session {
        return Err(McpError::new(
            "stale-session",
            "submission session does not match the captured attempt; stale sessions refuse",
        ));
    }
    if batch.is_empty() {
        return Err(McpError::new(
            "empty-batch",
            "submission batches carry at least one entry",
        ));
    }
    let mut matched = Vec::with_capacity(batch.len());
    let mut seen = std::collections::HashSet::new();
    for entry in batch {
        if entry.target.contains('/') || entry.target.contains('\\') || entry.target.contains("..")
        {
            return Err(McpError::new(
                "arbitrary-path",
                format!(
                    "submission target {:?} looks like a path; submissions name only server-issued handles",
                    entry.target,
                ),
            ));
        }
        if !handle_grammar_valid(&entry.target) {
            return Err(McpError::new(
                "unknown-target",
                format!(
                    "submission target {:?} is not an issued handle for this session",
                    entry.target,
                ),
            ));
        }
        let Some(allowed) = context.allowed.iter().find(|a| a.handle == entry.target) else {
            return Err(McpError::new(
                "unknown-target",
                format!(
                    "submission target {:?} is not an issued handle for this session",
                    entry.target,
                ),
            ));
        };
        if McpRole::parse(&entry.role) != Some(allowed.role) {
            return Err(McpError::new(
                "role-mismatch",
                format!(
                    "submission target {:?} admits role {:?}, got {:?}",
                    entry.target,
                    allowed.role.as_str(),
                    entry.role,
                ),
            ));
        }
        match (&entry.content_text, &entry.content_base64) {
            (Some(_), Some(_)) => {
                return Err(McpError::new(
                    "malformed-content",
                    format!(
                        "submission target {:?} carries both text and base64 content; exactly one is admitted",
                        entry.target,
                    ),
                ));
            }
            (None, None) => {
                return Err(McpError::new(
                    "malformed-content",
                    format!(
                        "submission target {:?} carries no content; text or base64 is required",
                        entry.target,
                    ),
                ));
            }
            (Some(text), None) if text.is_empty() => {
                return Err(McpError::new(
                    "malformed-content",
                    format!(
                        "submission target {:?} carries empty text content",
                        entry.target,
                    ),
                ));
            }
            (None, Some(payload)) => {
                use base64::Engine as _;
                if base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .is_err()
                {
                    return Err(McpError::new(
                        "malformed-content",
                        format!(
                            "submission target {:?} carries malformed base64 content",
                            entry.target,
                        ),
                    ));
                }
            }
            _ => {}
        }
        if !seen.insert(entry.target.as_str()) {
            return Err(McpError::new(
                "duplicate-target",
                format!(
                    "submission target {:?} repeats within one batch; conflicting submissions refuse",
                    entry.target,
                ),
            ));
        }
        matched.push(allowed);
    }
    Ok(matched)
}
