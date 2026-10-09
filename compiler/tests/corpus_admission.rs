//! Corpus admission refuses unsupported ownership at compile time. These
//! tests inspect real owned emission and CLI shipping, not Corpus execution.

use canlang_compiler::cli::{Analyzer, CatalogAnalyzer};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::Severity;
use canlang_compiler::source::SourceDb;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/corpus-admission")
        .join(format!("{name}.can"))
}

fn cli(command: &str, name: &str, format: &str) -> (i32, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .arg(command)
        .arg(format!("--format={format}"))
        .arg("--catalog")
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(fixture(name))
        .output()
        .unwrap();
    assert!(output.stderr.is_empty(), "{:?}", output);
    (
        output.status.code().unwrap(),
        String::from_utf8(output.stdout).unwrap(),
    )
}

fn refusal(name: &str, canonical: &str) {
    let (code, output) = cli("check", name, "json");
    assert_eq!(code, 0, "{output}");
    let checked: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(checked["complete"], true);
    assert_eq!(checked["diagnostics"], serde_json::json!([]));
    let (code, output) = cli("compile", name, "json");
    assert_eq!(code, 10, "{output}");
    let rejected: Value = serde_json::from_str(&output).unwrap();
    assert!(rejected.get("artifact_version").is_none(), "{output}");
    assert!(rejected.get("modules").is_none(), "{output}");
    let source = std::fs::read_to_string(fixture(name)).unwrap();
    let start = source.find("corpus ").unwrap();
    let end = start + source[start..].find('\n').unwrap();
    assert_eq!(rejected["diagnostics"].as_array().unwrap().len(), 1);
    let diagnostic = &rejected["diagnostics"][0];
    assert_eq!(diagnostic["code"], "E6008");
    assert_eq!(diagnostic["severity"], "error");
    assert_eq!(
        diagnostic["message"],
        format!(
            "corpus {canonical}: corpus declarations have no supported emission; generated interfaces and runtime ownership are not implemented"
        )
    );
    assert_eq!(
        diagnostic["primary"],
        serde_json::json!({"file":0,"start":start,"end":end})
    );
    let (code, text) = cli("compile", name, "text");
    assert_eq!(code, 10, "{text}");
    assert!(text.contains("E6008") && text.contains(canonical), "{text}");
}

#[test]
fn local_foreign_alias_and_unchecked_model_refuse_shipping() {
    refusal("local", "Local.Handbook");
    refusal("foreign", "Knowledge.Handbook");
    // Missing attributes' semantic owners are not inferred by this gate.
    refusal("missing", "MissingOwner.Broken");
}

#[test]
fn grammar_refusal_and_static_judgment_admission_remain_separate() {
    for command in ["check", "compile"] {
        let (code, output) = cli(command, "bare", "json");
        assert_eq!(code, 10, "{output}");
        let rejected: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(rejected["diagnostics"][0]["code"], "E1204");
    }
    assert_eq!(cli("check", "judgment", "json").0, 0);
    let (code, output) = cli("compile", "judgment", "json");
    assert_eq!(code, 0, "{output}");
    let artifact: Value = serde_json::from_str(&output).unwrap();
    assert!(artifact.get("diagnostics").is_none());
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(js.contains("judgments:{\"Decisions.Verdict\":{sourceLanguage:\"en\",version:1n,questions:[{name:\"acceptable\",kind:\"noul\",instructions:"), "{js}");
    assert!(js.contains("(\"Acceptable?\",{},undefined,\"en\")"), "{js}");
    assert_eq!(js.matches("kind:\"noul\"").count(), 1);
}

#[test]
fn public_owned_emit_reports_refusal_and_preserves_sibling_outputs() {
    let original = std::fs::read_to_string(fixture("siblings")).unwrap();
    let corpus = "  corpus Handbook model=Item scope=title title=title content=title where=true from=deployment.knowledge\n";
    let unsupported = original.replace("  export Item", &format!("{corpus}  export Item"));
    let mut outputs = Vec::new();
    for (source, expect_error) in [(original, false), (unsupported, true)] {
        let mut db = SourceDb::new();
        db.add("siblings.can".into(), source.clone());
        let analyzer = CatalogAnalyzer::new(
            Some(root().join("packages/values/dist/catalog.json")),
            None,
            root(),
        );
        let owned = analyzer.analyze_owned(&db, "corpus-test");
        assert!(owned.result.complete);
        assert!(!owned.result.has_errors(), "{:?}", owned.result.diagnostics);
        let (artifact, diagnostics) = emit(
            owned.program.as_ref().unwrap(),
            &EmitSources {
                db: &db,
                result: &owned.result,
                catalog: owned.catalog.as_ref(),
                options: EmitOptions::new(),
            },
        );
        if expect_error {
            assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
            assert_eq!(diagnostics[0].code, "E6008");
            assert_eq!(diagnostics[0].severity, Severity::Error);
            assert_eq!(
                diagnostics[0].message,
                "corpus Library.Handbook: corpus declarations have no supported emission; generated interfaces and runtime ownership are not implemented"
            );
            let start = source.find("corpus ").unwrap();
            assert_eq!(diagnostics[0].primary.start as usize, start);
            assert_eq!(
                diagnostics[0].primary.end as usize,
                start + corpus.trim().len()
            );
        } else {
            assert!(diagnostics.is_empty(), "{diagnostics:?}");
        }
        assert!(!artifact.modules.is_empty());
        assert!(!artifact.callables.is_empty());
        assert!(!artifact.models.is_empty());
        assert_eq!(artifact.migrations.len(), 1);
        assert!(!artifact.tests.is_empty());
        // Source identity/maps correctly change; semantic sibling outputs do not.
        let mut json: Value = serde_json::from_str(&to_json(&artifact)).unwrap();
        json.as_object_mut().unwrap().remove("sources");
        for module in json["modules"].as_array_mut().unwrap() {
            module.as_object_mut().unwrap().remove("map");
        }
        for test in json["tests"].as_array_mut().unwrap() {
            test["module"].as_object_mut().unwrap().remove("map");
        }
        outputs.push(json);
    }
    assert_eq!(outputs[0], outputs[1]);
    let (code, output) = cli("compile", "siblings", "json");
    assert_eq!(code, 0, "{output}");
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap()["artifact_version"],
        1
    );
}
