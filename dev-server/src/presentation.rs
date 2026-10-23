//! Human wording derived from authoritative observations, never lifecycle decisions.
use crate::model::*;
use ratatui::text::Line;

/// Strip terminal instructions and directional controls before rendering owner text.
pub fn terminal_text(value: &str, limit: usize) -> String {
    if limit == 0 {
        return String::new();
    }
    let mut output = String::new();
    let mut count = 0;
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.next() {
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\x07' || (next == '\x1b' && chars.peek() == Some(&'\\')) {
                            if next == '\x1b' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some('P' | 'X' | '^' | '_') => {
                    while let Some(next) = chars.next() {
                        if next == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if ch.is_control() || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
            output.push(' ');
        } else {
            output.push(ch);
        }
        count += 1;
        if count >= limit {
            break;
        }
    }
    output
}

/// Routine status exposes only a public HTTP(S) origin, never access credentials.
pub fn safe_origin(value: &str) -> Option<String> {
    let (scheme, remainder) = value.split_once("://")?;
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let authority = remainder.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    if host.is_empty()
        || host
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\')
    {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// Wrap by display cells, including fullwidth characters, without byte slicing.
pub fn wrap(value: &str, columns: u16) -> Vec<String> {
    let width = usize::from(columns.max(1));
    let clean = terminal_text(value, 4000);
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut used = 0;
    for ch in clean.chars() {
        let size = Line::raw(ch.to_string()).width();
        if used + size > width && !current.is_empty() {
            lines.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push(ch);
        used += size;
    }
    lines.push(current);
    lines
}

pub fn bounded_history(lines: &[String]) -> Vec<String> {
    let mut result: Vec<_> = lines
        .iter()
        .take(40)
        .map(|line| terminal_text(line, 2000))
        .collect();
    if lines.len() > 40
        || lines
            .iter()
            .take(40)
            .any(|line| line.chars().count() > 2000)
    {
        result.push(
            "Display truncated; retained details may be available through details/logs.".into(),
        );
    }
    result
}

pub fn lifecycle_label(value: Lifecycle) -> &'static str {
    match value {
        Lifecycle::Starting => "starting",
        Lifecycle::Running => "running",
        Lifecycle::Stopping => "stopping",
        Lifecycle::ShutdownIncomplete => "cleanup incomplete",
        Lifecycle::Stopped => "stopped",
    }
}

fn phase_label(value: CheckPhase) -> &'static str {
    match value {
        CheckPhase::Queued => "waiting for check",
        CheckPhase::Capturing => "capturing inputs",
        CheckPhase::CheckingSource => "checking source",
        CheckPhase::PreparingPreview => "preparing preview",
        CheckPhase::Publishing => "publishing preview",
    }
}

fn source_label(value: SourceResult) -> &'static str {
    match value {
        SourceResult::Valid => "valid",
        SourceResult::Errors => "source errors",
        SourceResult::Limited => "limited",
        SourceResult::Incomplete => "incomplete",
        SourceResult::Unsupported => "unsupported",
        SourceResult::ToolFailure => "tool failure",
        SourceResult::Superseded => "superseded",
        SourceResult::Cancelled => "cancelled",
    }
}

fn preview_label(value: PreviewResult) -> &'static str {
    match value {
        PreviewResult::Ready => "ready",
        PreviewResult::Unavailable => "unavailable",
        PreviewResult::Failed => "failed",
        PreviewResult::Superseded => "superseded",
    }
}

fn freshness_label(value: Freshness) -> &'static str {
    match value {
        Freshness::Current => "current",
        Freshness::Older => "last good; older source",
        Freshness::Unconfirmed => "freshness unconfirmed",
        Freshness::NotApplicable => "not applicable",
    }
}

fn seconds(ms: u64) -> String {
    format!("{:.1}s", ms as f64 / 1000.0)
}

pub fn identity(state: &Snapshot, owned: bool) -> String {
    format!(
        "Can | {} | {} checks | {}",
        terminal_text(&state.app, 100),
        match state.mode {
            CheckMode::Manual => "manual",
            CheckMode::Automatic => "automatic",
        },
        if owned {
            "started here; Ctrl+C stops"
        } else {
            "attached; Ctrl+C detaches"
        }
    )
}

/// Important facts in priority order; width/height are solely renderer concerns.
pub fn status(state: &Snapshot, now: u64, connected: bool) -> Vec<String> {
    let mut lines = Vec::new();
    if !connected {
        lines.push("Control disconnected; session state unknown. Last observed:".into());
    }
    lines.push(format!("Server {}", lifecycle_label(state.lifecycle)));
    if let Some(operation) = &state.operation {
        lines.push(format!(
            "Check {}{} | {} phase; {} total | {}",
            phase_label(operation.phase),
            operation
                .subphase
                .as_ref()
                .map(|s| format!(" / {}", terminal_text(s, 120)))
                .unwrap_or_default(),
            seconds(now.saturating_sub(operation.phase_started_at)),
            seconds(now.saturating_sub(operation.started_at)),
            operation.revision.as_deref().unwrap_or("awaiting capture")
        ));
    } else if state.last_outcome.is_none() {
        lines.push(
            match state.mode {
                CheckMode::Manual => "Check not run; enter check",
                CheckMode::Automatic => "Initial check pending",
            }
            .into(),
        );
    }
    lines.push(if state.preview.availability == Availability::Serving {
        format!(
            "Preview serving {} ({}){}",
            state
                .preview
                .revision
                .as_deref()
                .unwrap_or("unknown revision"),
            freshness_label(state.preview.freshness),
            state
                .preview
                .origin
                .as_deref()
                .map(|value| format!(
                    " {}",
                    safe_origin(value).unwrap_or_else(|| "origin unavailable".into())
                ))
                .unwrap_or_default()
        )
    } else {
        "Preview unavailable".into()
    });
    if state.shutdown_error.is_some() {
        lines.push("Cleanup incomplete; retry stop through the owning session.".into());
    }
    if !state.admission.reasons.is_empty() {
        lines.push(format!(
            "Blocked: {}",
            state
                .admission
                .reasons
                .iter()
                .map(|s| terminal_text(s, 120))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(outcome) = &state.last_outcome {
        lines.push(format!(
            "Last check {}: {}; preview {} ({} total)",
            outcome.revision.as_deref().unwrap_or("uncaptured"),
            source_label(outcome.source),
            preview_label(outcome.preview),
            seconds(outcome.finished_at.saturating_sub(outcome.started_at))
        ));
        if let Some(reason) = &outcome.reason {
            lines.push(format!("Result: {}", terminal_text(reason, 500)));
        }
    }
    lines.push(format!(
        "Source {} | capture {}",
        state.source_revision.as_deref().unwrap_or("uncaptured"),
        match state.capture {
            CaptureState::Confirmed => "confirmed",
            CaptureState::Unconfirmed => "unconfirmed",
            CaptureState::Incomplete => "incomplete",
        }
    ));
    lines
}

pub fn actions(state: &Snapshot, owned: bool, connected: bool) -> String {
    if !connected {
        return "Next: wait for verified reconnect; detach to leave".into();
    }
    let mut available = Vec::new();
    if state.admission.check {
        available.push("check");
    }
    if state.admission.open {
        available.push("open");
    }
    if owned {
        available.push(if state.admission.retry_cleanup {
            "stop (retry cleanup)"
        } else {
            "stop"
        });
    }
    available.extend(["details", "logs", "status", "help"]);
    if !owned {
        available.push("detach");
    }
    format!("Actions: {}", available.join(" | "))
}

pub fn outcome(state: &Snapshot) -> Vec<String> {
    let Some(result) = &state.last_outcome else {
        return Vec::new();
    };
    let mut lines = vec![format!(
        "{}: source {}; preview {}; {} total.",
        result.revision.as_deref().unwrap_or("Uncaptured check"),
        source_label(result.source),
        preview_label(result.preview),
        seconds(result.finished_at.saturating_sub(result.started_at))
    )];
    if let Some(reason) = &result.reason {
        lines.push(terminal_text(reason, 2000));
    }
    if state.preview.availability == Availability::Serving
        && state.preview.freshness != Freshness::Current
    {
        lines.push(format!(
            "Last good preview remains at {} ({}).",
            state
                .preview
                .revision
                .as_deref()
                .unwrap_or("unknown revision"),
            freshness_label(state.preview.freshness)
        ));
    }
    lines
}

/// Ignore timer and transport sequence changes when deciding plain transcript output.
pub fn transition_key(state: &Snapshot, connected: bool) -> String {
    format!(
        "{connected}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}",
        state.lifecycle,
        state.source_revision,
        state.capture,
        state
            .operation
            .as_ref()
            .map(|op| (&op.id, op.phase, &op.subphase)),
        state.last_outcome.as_ref().map(|outcome| &outcome.id),
        state.preview,
        state.admission,
        state.shutdown_error
    )
}
