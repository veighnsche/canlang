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
