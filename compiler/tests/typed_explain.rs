//! Fixed byte contracts for explain DTOs and the actual CLI consumer.
use canlang_compiler::diagnostic::Severity;
use canlang_compiler::explain::{CodeInfo, entry_to_json};
use std::process::Command;

#[test]
fn six_keys_keep_blank_values_controls_unicode_and_no_newline() {
    let info = CodeInfo {
        code: "Etest",
        title: "",
        severity: Severity::Warning,
        explanation: "quote\" slash\\ LF\nCR\rtab\t\u{0}\u{8}\u{c}\u{1f} é😀",
        example_valid: "",
        example_invalid: "do\n let x = \"a\"\n",
    };
    let expected = r#"{"code":"Etest","title":"","severity":"warning","explanation":"quote\" slash\\ LF\nCR\rtab\t\u0000\u0008\u000c\u001f é😀","example_valid":"","example_invalid":"do\n let x = \"a\"\n"}"#;
    let json = entry_to_json(&info);
    assert_eq!(json, expected);
    assert!(!json.contains('\n'));
    let decoded: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.as_object().unwrap().len(), 6);
    assert_eq!(decoded["explanation"], info.explanation);
    assert_eq!(decoded["example_valid"], "");
    assert_eq!(decoded["example_invalid"], info.example_invalid);
}

#[test]
fn every_severity_uses_its_fixed_machine_spelling() {
    for (severity, expected) in [
        (
            Severity::Error,
            r#"{"code":"","title":"","severity":"error","explanation":"","example_valid":"","example_invalid":""}"#,
        ),
        (
            Severity::Warning,
            r#"{"code":"","title":"","severity":"warning","explanation":"","example_valid":"","example_invalid":""}"#,
        ),
        (
            Severity::Info,
            r#"{"code":"","title":"","severity":"info","explanation":"","example_valid":"","example_invalid":""}"#,
        ),
    ] {
        assert_eq!(
            entry_to_json(&CodeInfo {
                code: "",
                title: "",
                severity,
                explanation: "",
                example_valid: "",
                example_invalid: "",
            }),
            expected
        );
    }
}

#[test]
fn cli_known_code_matches_full_fixture_and_adds_one_newline() {
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["explain", " e1001 ", "--format=json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    // Authored from the catalog's documented entry, independently of its DTO.
    let expected = concat!(
        r#"{"code":"E1001","title":"bare-carriage-return","severity":"error","explanation":"Source uses LF or CRLF line endings (GRAMMAR Tokens and layout). A carriage return not immediately followed by LF is a bare CR, reported once where it stands; the byte stays as an error token so coverage is preserved. Normalize the file to LF and remove the stray CR.","example_valid":"app T\nGiven\nWhen\nThen\n## note\n","example_invalid":"app T\nGiven\nWhen\nThen\n## a\rb\n"}"#,
        "\n",
    );
    assert_eq!(output.stdout, expected.as_bytes());
}
