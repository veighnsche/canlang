//! The actual CLI refuses unbound inline-format variables before emission.
use std::{path::Path, process::Command};

#[test]
fn anonymous_localized_format_uses_its_checked_empty_parameter_schema() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let run = |command: &str, declaration: &str| {
        let source = format!("app Anonymous\nGiven\n {declaration}\nWhen\nThen\n");
        let input = scratch.path().join("inline.can");
        std::fs::write(&input, &source).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let output =
            canlang_compiler::json::parse(&String::from_utf8_lossy(&result.stdout)).unwrap();
        (source, result, output)
    };
    for expression in [
        "format(\"Hello\"@{nl=\"Dag\"},locale=null)",
        "format(locale=null,descriptor=\"Hello\"@{})",
        "format(\"'{d,time}'\"@{},locale=null)",
        "format(\"{d}\",{d=\"plain\"})",
    ] {
        let (_, result, output) = run("compile", &format!("derive shown():text = {expression}"));
        assert!(result.status.success(), "{expression}: {output:?}");
        assert!(!output.get("modules").unwrap().as_arr().unwrap().is_empty());
    }
    // An unrelated raw descriptor remains structurally checked without being
    // misdeclared as a text result or selected as an empty-schema format.
    let (_, result, output) = run("check", "derive shown():int = count([\"{d,time}\"@{}])");
    assert!(result.status.success(), "{output:?}");
    assert!(
        output
            .get("diagnostics")
            .unwrap()
            .as_arr()
            .unwrap()
            .is_empty()
    );
    for (expression, literal) in [
        ("format(\"{d,time}\"@{},locale=null)", "\"{d,time}\""),
        ("format(((\"{d,time}\"@{})),locale=null)", "\"{d,time}\""),
        (
            "format(locale=null,descriptor=(\"{d,time}\"@{}))",
            "\"{d,time}\"",
        ),
        (
            "format(\"Hello\"@{nl=\"{d,time,short}\"},locale=null)",
            "\"{d,time,short}\"",
        ),
        ("format(\"{d,time,xx}\"@{},locale=null)", "\"{d,time,xx}\""),
        ("format(\"{d}\"@{},locale=null)", "\"{d}\""),
        (
            "format(\"{kind,select,other {ok}}\"@{},locale=null)",
            "\"{kind,select,other {ok}}\"",
        ),
    ] {
        let (source, result, output) =
            run("compile", &format!("derive shown():text = {expression}"));
        assert_eq!(result.status.code(), Some(10), "{expression}: {output:?}");
        assert!(output.get("modules").is_none(), "refusal emitted modules");
        let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
        assert_eq!(diagnostics.len(), 1, "{expression}: {output:?}");
        let diagnostic = &diagnostics[0];
        assert_eq!(diagnostic.get("code").unwrap().as_str(), Some("E5007"));
        let variable = if expression.contains("kind,select") {
            "kind"
        } else {
            "d"
        };
        assert_eq!(diagnostic.get("message").unwrap().as_str(), Some(format!("invalid message pattern: message pattern uses undeclared variable {{{variable}}}").as_str()));
        let primary = diagnostic.get("primary").unwrap();
        let start = source.find(literal).unwrap();
        assert_eq!(primary.get("start").unwrap().as_i64(), Some(start as i64));
        assert_eq!(
            primary.get("end").unwrap().as_i64(),
            Some((start + literal.len()) as i64)
        );
    }
    let (source, result, output) = run(
        "compile",
        "message label(seed:text=format(\"{d}\"@{},locale=null))=\"{seed}\"@{}",
    );
    assert_eq!(result.status.code(), Some(10), "{output:?}");
    assert!(output.get("modules").is_none());
    let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
    assert_eq!(diagnostics.len(), 1, "{output:?}");
    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.get("code").unwrap().as_str(), Some("E5007"));
    assert_eq!(
        diagnostic.get("message").unwrap().as_str(),
        Some("invalid message pattern: message pattern uses undeclared variable {d}")
    );
    let start = source.find("\"{d}\"").unwrap();
    let primary = diagnostic.get("primary").unwrap();
    assert_eq!(primary.get("start").unwrap().as_i64(), Some(start as i64));
    assert_eq!(
        primary.get("end").unwrap().as_i64(),
        Some((start + 5) as i64)
    );
}
