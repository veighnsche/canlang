//! One diagnostic engine for CLI, compiler, linter and LSP.
//!
//! Implements the machine format from `implementation/DIAGNOSTICS.md`:
//! versioned envelope, stable codes, canonical byte spans, deterministic
//! ordering. Human text rendering shares the same data.

use crate::source::{SourceDb, Span};
use std::fmt::Write as _;

/// Diagnostic severity. Only [`Severity::Error`] blocks compilation output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// Normative violation or unavailable required capability. Blocks output.
    Error,
    /// Suspicious but valid source. Never blocks output.
    Warning,
    /// Optional information. Kept out of default build output.
    Info,
}

impl Severity {
    /// Machine spelling used in JSON output.
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// A secondary span with its own message, e.g. the shadowed declaration.
#[derive(Debug, Clone)]
pub struct Related {
    /// Related source range.
    pub span: Span,
    /// Concise explanation of the relation.
    pub message: String,
}

/// One diagnostic: stable code, severity, message and spans.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    /// Stable machine code, e.g. `E1001`. See the lane-01 status plan for
    /// the category allocation; `can explain CODE` documents each code.
    pub code: &'static str,
    /// Severity of this finding.
    pub severity: Severity,
    /// Concise one-line message. No shell commands, no fix payloads.
    pub message: String,
    /// Primary source range the message is about.
    pub primary: Span,
    /// Secondary spans with explanations.
    pub related: Vec<Related>,
    /// Documented machine tags, e.g. `unnecessary`.
    pub tags: Vec<String>,
}

impl Diagnostic {
    /// Create an error diagnostic with no related spans or tags.
    pub fn error(code: &'static str, message: String, primary: Span) -> Self {
        Self {
            code,
            severity: Severity::Error,
            message,
            primary,
            related: Vec::new(),
            tags: Vec::new(),
        }
    }
}

/// Source revision entry in the result envelope.
#[derive(Debug, Clone)]
pub struct SourceEntry {
    /// Canonical source id.
    pub id: u32,
    /// Display path.
    pub path: String,
    /// Lowercase hex SHA-256 of the analyzed bytes.
    pub sha256: String,
}

/// Complete versioned result of one analysis pass.
#[derive(Debug, Clone)]
pub struct DiagnosticResult {
    /// Tool name, always `can`.
    pub tool: String,
    /// Compiler version (`CARGO_PKG_VERSION`).
    pub tool_version: String,
    /// Language version analyzed, e.g. `1.0`.
    pub language_version: String,
    /// Envelope schema version, starting at 1.
    pub schema_version: u32,
    /// Every source consulted, in id order.
    pub sources: Vec<SourceEntry>,
    /// False when analysis was incomplete or cancelled; diagnostics must
    /// then never be read as "only these problems exist".
    pub complete: bool,
    /// Diagnostics in deterministic order: file, start byte, then code.
    pub diagnostics: Vec<Diagnostic>,
    /// Diagnostics withheld by an output limit. Always disclosed; a
    /// nonzero value means the output must never suggest a clean file.
    pub omitted: u32,
}

impl DiagnosticResult {
    /// Create an empty complete result for the running tool version.
    pub fn new(tool_version: &str, language_version: &str, schema_version: u32) -> Self {
        Self {
            tool: "can".to_string(),
            tool_version: tool_version.to_string(),
            language_version: language_version.to_string(),
            schema_version,
            sources: Vec::new(),
            complete: true,
            diagnostics: Vec::new(),
            omitted: 0,
        }
    }

    /// Record every source in `db` in id order.
    pub fn add_sources(&mut self, db: &SourceDb) {
        for (id, source) in db.iter() {
            self.sources.push(SourceEntry {
                id: id.0,
                path: source.path.clone(),
                sha256: source.sha256.clone(),
            });
        }
    }

    /// Push a diagnostic. Call [`DiagnosticResult::finish`] before rendering.
    pub fn push(&mut self, diagnostic: Diagnostic) {
        self.diagnostics.push(diagnostic);
    }

    /// Whether any error-severity diagnostic is present.
    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|d| d.severity == Severity::Error)
    }

    /// Sort diagnostics into canonical order. Idempotent.
    pub fn finish(&mut self) {
        self.diagnostics.sort_by(|a, b| {
            (a.primary.file, a.primary.start, a.code).cmp(&(
                b.primary.file,
                b.primary.start,
                b.code,
            ))
        });
    }

    /// Render the compact deterministic JSON envelope (single line).
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        out.push_str("{\"tool\":");
        push_json_str(&mut out, &self.tool);
        out.push_str(",\"tool_version\":");
        push_json_str(&mut out, &self.tool_version);
        out.push_str(",\"language_version\":");
        push_json_str(&mut out, &self.language_version);
        let _ = write!(out, ",\"schema_version\":{}", self.schema_version);
        out.push_str(",\"sources\":[");
        for (i, s) in self.sources.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            let _ = write!(out, "{{\"id\":{},\"path\":", s.id);
            push_json_str(&mut out, &s.path);
            out.push_str(",\"sha256\":");
            push_json_str(&mut out, &s.sha256);
            out.push('}');
        }
        let _ = write!(out, "],\"complete\":{},\"diagnostics\":[", self.complete);
        for (i, d) in self.diagnostics.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"code\":");
            push_json_str(&mut out, d.code);
            out.push_str(",\"severity\":");
            push_json_str(&mut out, d.severity.as_str());
            out.push_str(",\"message\":");
            push_json_str(&mut out, &d.message);
            let _ = write!(
                out,
                ",\"primary\":{{\"file\":{},\"start\":{},\"end\":{}}}",
                d.primary.file.0, d.primary.start, d.primary.end
            );
            out.push_str(",\"related\":[");
            for (j, r) in d.related.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                let _ = write!(
                    out,
                    "{{\"file\":{},\"start\":{},\"end\":{},\"message\":",
                    r.span.file.0, r.span.start, r.span.end
                );
                push_json_str(&mut out, &r.message);
                out.push('}');
            }
            out.push_str("],\"tags\":[");
            for (j, t) in d.tags.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                push_json_str(&mut out, t);
            }
            out.push_str("]}");
        }
        let _ = write!(out, "],\"omitted\":{}}}", self.omitted);
        out
    }

    /// Render one human line per diagnostic: `path:line:col: severity code message`.
    ///
    /// Related spans render as indented follow-up lines. Requires the
    /// sources the spans point at; unknown files render as `<unknown>`.
    pub fn to_text(&self, db: &SourceDb) -> String {
        let mut out = String::new();
        for d in &self.diagnostics {
            out.push_str(&render_loc(db, d.primary));
            let _ = writeln!(
                out,
                ": {} {} {}",
                d.severity.as_str(),
                d.code,
                single_line(&d.message)
            );
            for r in &d.related {
                out.push_str("  related ");
                out.push_str(&render_loc(db, r.span));
                let _ = writeln!(out, ": {}", single_line(&r.message));
            }
        }
        if !self.complete {
            out.push_str("note: analysis incomplete; more problems may exist\n");
        }
        if self.omitted > 0 {
            let _ = writeln!(out, "note: {} diagnostic(s) omitted", self.omitted);
        }
        out
    }
}

fn render_loc(db: &SourceDb, span: Span) -> String {
    use crate::source::LineIndex;
    match db.get(span.file) {
        Some(source) => {
            let index = LineIndex::new(&source.text);
            let (line, col) = index.line_col(&source.text, span.start);
            format!("{}:{line}:{col}", source.path)
        }
        None => "<unknown>".to_string(),
    }
}

fn single_line(message: &str) -> String {
    message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// Append `s` as a JSON double-quoted string with minimal escapes.
pub fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{SourceDb, SourceId};

    fn sample() -> (SourceDb, DiagnosticResult) {
        let mut db = SourceDb::new();
        let id = db.add("a.can".into(), "app A\n Given\n".into());
        let mut result = DiagnosticResult::new("0.1.0", "1.0", 1);
        result.add_sources(&db);
        result.push(Diagnostic::error(
            "E1001",
            "expected \"Given\" marker".into(),
            Span::new(id, 6, 11),
        ));
        result.finish();
        (db, result)
    }

    #[test]
    fn json_is_deterministic() {
        let (_, result) = sample();
        let first = result.to_json();
        let second = result.to_json();
        assert_eq!(first, second);
        assert!(!first.contains('\n'));
        assert!(first.starts_with("{\"tool\":\"can\",\"tool_version\":\"0.1.0\""));
        assert!(first.contains("\"code\":\"E1001\""));
        assert!(first.contains("\"primary\":{\"file\":0,\"start\":6,\"end\":11}"));
        assert!(first.ends_with("\"omitted\":0}"));
    }

    #[test]
    fn json_escapes_control_chars() {
        let mut out = String::new();
        push_json_str(&mut out, "a\"b\\c\nd\u{1}e\u{2603}");
        assert_eq!(out, "\"a\\\"b\\\\c\\nd\\u0001e\u{2603}\"");
    }

    #[test]
    fn text_rendering_points_at_source() {
        let (db, result) = sample();
        assert_eq!(
            result.to_text(&db),
            "a.can:2:1: error E1001 expected \"Given\" marker\n"
        );
    }

    #[test]
    fn finish_sorts_by_file_start_code() {
        let mut db = SourceDb::new();
        let a = db.add("a.can".into(), "xx".into());
        let b = db.add("b.can".into(), "xx".into());
        let mut result = DiagnosticResult::new("0.1.0", "1.0", 1);
        result.add_sources(&db);
        result.push(Diagnostic::error("E1002", "b".into(), Span::new(b, 0, 1)));
        result.push(Diagnostic::error(
            "E1003",
            "a-late".into(),
            Span::new(a, 1, 2),
        ));
        result.push(Diagnostic::error(
            "E1001",
            "a-early".into(),
            Span::new(a, 0, 1),
        ));
        result.finish();
        let codes: Vec<_> = result.diagnostics.iter().map(|d| d.code).collect();
        assert_eq!(codes, vec!["E1001", "E1003", "E1002"]);
        assert!(result.has_errors());
        let _ = SourceId(0);
    }
}
