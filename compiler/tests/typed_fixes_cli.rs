//! Actual CLI envelope extension, including the empty but present fixes array.
use canlang_compiler::json::{self, Json};
use std::process::Command;

#[test]
fn lint_fix_flag_controls_presence_order_and_single_newline() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("empty.can");
    let catalog = dir.path().join("catalog.json");
    std::fs::write(&source, "app Demo\nGiven\nWhen\nThen\n").unwrap();
    std::fs::write(
        &catalog,
        r#"{"language_version":"1.0","catalog_version":"test","entries":[]}"#,
    )
    .unwrap();
    let mut without = String::new();
    for fix in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
        command
            .args(["lint", "--format=json", "--catalog"])
            .arg(&catalog)
            .arg(&source);
        if fix {
            command.arg("--fix");
        }
        let result = command.output().unwrap();
        assert!(result.status.success(), "{result:?}");
        assert!(result.stderr.is_empty());
        let text = String::from_utf8(result.stdout).unwrap();
        assert_eq!(text.bytes().filter(|byte| *byte == b'\n').count(), 1);
        let Json::Obj(fields) = json::parse(&text).unwrap() else {
            panic!("expected envelope")
        };
        let keys: Vec<_> = fields.iter().map(|(key, _)| key.as_str()).collect();
        let mut expected = vec![
            "tool",
            "tool_version",
            "language_version",
            "schema_version",
            "sources",
            "complete",
            "diagnostics",
            "omitted",
        ];
        if fix {
            expected.push("fixes");
        }
        assert_eq!(keys, expected);
        let envelope = Json::Obj(fields);
        assert_eq!(
            envelope.get("diagnostics").unwrap().as_arr().unwrap().len(),
            0
        );
        if fix {
            assert_eq!(envelope.get("fixes").unwrap().as_arr().unwrap().len(), 0);
            assert_eq!(
                text,
                format!("{},\"fixes\":[]}}\n", without.strip_suffix("}\n").unwrap())
            );
        } else {
            assert!(envelope.get("fixes").is_none());
            without = text;
        }
    }
}
