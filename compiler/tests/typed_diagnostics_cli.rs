//! Real authoring CLI witnesses for typed diagnostic JSON and newline policy.
use canlang_compiler::json::{Json, parse};
use std::process::Command;

#[test]
fn check_lint_and_fmt_diagnostics_keep_schema_order_and_one_newline() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("bad.can");
    std::fs::write(&source, "app Broken\n").unwrap();
    let catalog = dir.path().join("catalog.json");
    std::fs::write(
        &catalog,
        r#"{"language_version":"1.0","catalog_version":"2.5.0-test","entries":[]}"#,
    )
    .unwrap();
    for command in ["check", "lint", "fmt"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_can"));
        child.arg(command);
        if command != "fmt" {
            child.arg("--format=json").arg("--catalog").arg(&catalog);
        }
        let output = child.arg(&source).output().unwrap();
        assert_eq!(output.status.code(), Some(10), "{command}: {output:?}");
        assert!(output.stderr.is_empty(), "{command}: {output:?}");
        let text = std::str::from_utf8(&output.stdout).unwrap();
        assert!(text.ends_with("}\n"));
        assert_eq!(text.bytes().filter(|b| *b == b'\n').count(), 1);
        let Json::Obj(fields) = parse(text).unwrap() else {
            panic!("expected envelope")
        };
        assert_eq!(
            fields
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec![
                "tool",
                "tool_version",
                "language_version",
                "schema_version",
                "sources",
                "complete",
                "diagnostics",
                "omitted"
            ]
        );
        let value = Json::Obj(fields);
        assert_eq!(value.get("tool").unwrap().as_str(), Some("can"));
        assert_eq!(value.get("schema_version").unwrap().as_i64(), Some(1));
        assert_eq!(value.get("complete").unwrap().as_bool(), Some(true));
        assert_eq!(value.get("omitted").unwrap().as_i64(), Some(0));
        let sources = value.get("sources").unwrap().as_arr().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].get("path").unwrap().as_str(), source.to_str());
        let diagnostics = value.get("diagnostics").unwrap().as_arr().unwrap();
        assert_eq!(diagnostics.len(), 1, "{command}: {text}");
        assert_eq!(diagnostics[0].get("code").unwrap().as_str(), Some("E1204"));
        assert_eq!(
            diagnostics[0].get("message").unwrap().as_str(),
            Some("package is missing Given/When/Then")
        );
        assert_eq!(
            sources[0].get("sha256").unwrap().as_str(),
            Some("a1187edf8f43ac74fc1c3d6458e4b0a95d5fc8b0502ea9cac650a854930c4da0")
        );
        for diagnostic in diagnostics {
            assert_eq!(diagnostic.get("severity").unwrap().as_str(), Some("error"));
            let primary = diagnostic.get("primary").unwrap();
            assert_eq!(primary.get("file").unwrap().as_i64(), Some(0));
            for key in ["start", "end"] {
                assert!((0..=11).contains(&primary.get(key).unwrap().as_i64().unwrap()));
            }
            assert!(diagnostic.get("related").unwrap().as_arr().is_some());
            assert!(diagnostic.get("tags").unwrap().as_arr().is_some());
        }
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "app Broken\n");
    }
}
