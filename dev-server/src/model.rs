use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Starting,
    Running,
    Stopping,
    ShutdownIncomplete,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckMode {
    Manual,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckPhase {
    Queued,
    Capturing,
    CheckingSource,
    PreparingPreview,
    Publishing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceResult {
    Valid,
    Errors,
    Limited,
    Incomplete,
    Unsupported,
    ToolFailure,
    Superseded,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewResult {
    Ready,
    Unavailable,
    Failed,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Confirmed,
    Unconfirmed,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Unavailable,
    Serving,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    NotApplicable,
    Current,
    Older,
    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub revision: Option<String>,
    pub phase: CheckPhase,
    pub subphase: Option<String>,
    pub started_at: u64,
    pub phase_started_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub id: String,
    pub revision: Option<String>,
    pub source: SourceResult,
    pub preview: PreviewResult,
    pub reason: Option<String>,
    pub started_at: u64,
    pub finished_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewObservation {
    pub availability: Availability,
    pub revision: Option<String>,
    pub build: Option<String>,
    pub origin: Option<String>,
    pub freshness: Freshness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub check: bool,
    pub open: bool,
    pub retry_cleanup: bool,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: String,
    pub session: String,
    pub sequence: u64,
    pub app: String,
    pub source_path: String,
    pub mode: CheckMode,
    pub lifecycle: Lifecycle,
    pub revision: Option<String>,
    pub source_revision: Option<String>,
    pub capture: CaptureState,
    pub operation: Option<Operation>,
    pub last_outcome: Option<Outcome>,
    pub preview: PreviewObservation,
    pub admission: Admission,
    pub shutdown_error: Option<String>,
}
