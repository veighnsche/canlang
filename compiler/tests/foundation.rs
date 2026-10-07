//! Integration tests for the slice-0 foundation: source manager,
//! hashes, line index and the diagnostic engine.

use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult, Severity};
use canlang_compiler::source::{LineIndex, SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

#[test]
fn source_hashes_are_stable_content_hashes() {
    let mut db = SourceDb::new();
    let id = db.add("x.can".into(), "app X\n".into());
    let source = db.get(id).unwrap();
    // Verified against `sha256sum` for "app X\n".
    assert_eq!(
        source.sha256,
        "b4c89cf7d99a78f97b90fa2cce281cc75c215289eebfb7cf5df46e4740743ea8"
    );
    assert!(source.sha256.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn line_index_handles_crlf_and_unicode() {
    let text = "l\u{00e9}\r\n\u{1F600}\n";
    let index = LineIndex::new(text);
    assert_eq!(index.line_col(text, 0), (1, 1));
    assert_eq!(index.line_col(text, 5), (2, 1));
    // LSP: emoji line start is line 1 (0-based), column 0.
    assert_eq!(index.to_lsp(text, 5, true), (1, 0));
    // One UTF-16 unit for é, two for the emoji.
    assert_eq!(index.to_lsp(text, 3, true), (0, 2));
    assert_eq!(index.to_lsp(text, 9, true), (1, 2));
}

#[test]
fn diagnostic_envelope_round_trip_shape() {
    let mut db = SourceDb::new();
    let id = db.add("main.can".into(), "app Main\n".into());
    let mut result = DiagnosticResult::new("0.1.0", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    let mut warning = Diagnostic::error("W1001", "unreachable effect".into(), Span::new(id, 0, 3));
    warning.severity = Severity::Warning;
    warning.tags.push("unreachable".into());
    result.push(warning);
    result.finish();
    let json = result.to_json();
    assert!(json.contains("\"schema_version\":1"));
    assert!(json.contains("\"language_version\":\"1.0\""));
    assert!(json.contains("\"severity\":\"warning\""));
    assert!(json.contains("\"tags\":[\"unreachable\"]"));
    assert!(!result.has_errors());
    let text = result.to_text(&db);
    assert!(text.starts_with("main.can:1:1: warning W1001"));
}

#[test]
fn incomplete_analysis_says_so_in_text() {
    let db = SourceDb::new();
    let mut result = DiagnosticResult::new("0.1.0", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.complete = false;
    result.omitted = 3;
    let text = result.to_text(&db);
    assert!(text.contains("analysis incomplete"));
    assert!(text.contains("3 diagnostic(s) omitted"));
    assert!(result.to_json().contains("\"complete\":false"));
    assert!(result.to_json().contains("\"omitted\":3"));
}

#[test]
fn diagnostic_empty_envelope_exact_bytes() {
    let result = DiagnosticResult::new("0.1.0", "1.0", 1);
    assert_eq!(
        result.to_json(),
        r#"{"tool":"can","tool_version":"0.1.0","language_version":"1.0","schema_version":1,"sources":[],"complete":true,"diagnostics":[],"omitted":0}"#
    );
}

#[test]
fn diagnostic_populated_envelope_exact_bytes_and_order() {
    use canlang_compiler::diagnostic::{Related, SourceEntry};
    use canlang_compiler::source::SourceId;

    let mut result = DiagnosticResult::new("0.1.0", "1.0", 1);
    result.sources = vec![
        SourceEntry {
            id: 9,
            path: "z.can".into(),
            sha256: "hash-z".into(),
        },
        SourceEntry {
            id: 2,
            path: "a.can".into(),
            sha256: "hash-a".into(),
        },
    ];
    result.complete = false;
    result.omitted = 7;
    result.push(Diagnostic {
        code: "W1001",
        severity: Severity::Warning,
        message: "warning".into(),
        primary: Span::new(SourceId(9), 12, 24),
        related: vec![
            Related {
                span: Span::new(SourceId(2), 3, 8),
                message: "first".into(),
            },
            Related {
                span: Span::new(SourceId(9), 1, 2),
                message: "second".into(),
            },
        ],
        tags: vec!["unnecessary".into(), "deprecated".into()],
    });
    result.push(Diagnostic {
        code: "I1001",
        severity: Severity::Info,
        message: "info".into(),
        primary: Span::new(SourceId(2), 0, 1),
        related: vec![],
        tags: vec![],
    });
    result.push(Diagnostic::error(
        "E1001",
        "error".into(),
        Span::new(SourceId(2), 4, 5),
    ));
    // Deliberately do not finish: rendering must preserve the caller's order.
    assert_eq!(
        result.to_json(),
        r#"{"tool":"can","tool_version":"0.1.0","language_version":"1.0","schema_version":1,"sources":[{"id":9,"path":"z.can","sha256":"hash-z"},{"id":2,"path":"a.can","sha256":"hash-a"}],"complete":false,"diagnostics":[{"code":"W1001","severity":"warning","message":"warning","primary":{"file":9,"start":12,"end":24},"related":[{"file":2,"start":3,"end":8,"message":"first"},{"file":9,"start":1,"end":2,"message":"second"}],"tags":["unnecessary","deprecated"]},{"code":"I1001","severity":"info","message":"info","primary":{"file":2,"start":0,"end":1},"related":[],"tags":[]},{"code":"E1001","severity":"error","message":"error","primary":{"file":2,"start":4,"end":5},"related":[],"tags":[]}],"omitted":7}"#
    );
}

#[test]
fn diagnostic_control_and_unicode_exact_bytes() {
    use canlang_compiler::diagnostic::{Related, SourceEntry};
    use canlang_compiler::source::SourceId;

    let mut result = DiagnosticResult::new("0.1.0", "1.0", 1);
    result.sources.push(SourceEntry {
        id: 0,
        path: "é/🦀\"\\\n\r\t\u{8}\u{c}".into(),
        sha256: "hash".into(),
    });
    let controls: String = (0u8..32).map(char::from).collect();
    let mut diagnostic = Diagnostic::error(
        "E1001",
        format!("{controls}é/🦀\u{2028}\u{2029}"),
        Span::new(SourceId(0), 0, 0),
    );
    diagnostic.related.push(Related {
        span: Span::new(SourceId(0), 1, 2),
        message: "\u{8}\u{c}".into(),
    });
    diagnostic.tags.push("é/🦀\"\\".into());
    result.push(diagnostic);
    // Fixed wire expectation, written independently of either JSON encoder.
    assert_eq!(
        result.to_json(),
        concat!(
            r#"{"tool":"can","tool_version":"0.1.0","language_version":"1.0","schema_version":1,"sources":[{"id":0,"path":"é/🦀\"\\\n\r\t\u0008\u000c","sha256":"hash"}],"complete":true,"diagnostics":[{"code":"E1001","severity":"error","message":"\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\t\n\u000b\u000c\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001fé/🦀"#,
            "\u{2028}\u{2029}",
            r#"","primary":{"file":0,"start":0,"end":0},"related":[{"file":0,"start":1,"end":2,"message":"\u0008\u000c"}],"tags":["é/🦀\"\\"]}],"omitted":0}"#,
        )
    );
}
