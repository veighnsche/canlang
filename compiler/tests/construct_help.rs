//! Originating parser branches supply full inventories, never profile proofs.
use canlang_compiler::{diagnostic::DiagnosticResult, source::SourceId, syntax};
use serde_json::{Value, json};
use std::{collections::BTreeSet, process::Command};

fn parse(source: &str) -> Value {
    let (_, diagnostics) = syntax::parse_source(SourceId(0), source);
    let mut result = DiagnosticResult::new("test", "1.0", 1);
    result.diagnostics = diagnostics;
    serde_json::from_str(&result.to_json()).unwrap()
}
fn when(head: &str) -> String {
    format!("app T\nGiven\nWhen\n {head}\nThen\n")
}
fn routing(output: &Value) -> Vec<&Value> {
    output["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|diagnostic| diagnostic.get("construct_candidates"))
        .collect()
}
fn set(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn exact_branches_preserve_full_grammar_inventories_and_source_context() {
    let root = [
        "can.v1.app.implicit",
        "can.v1.app.composed",
        "can.v1.package",
        "can.v1.maintenance.migration",
    ];
    let scenarios = [
        "can.v1.when.scenario.user",
        "can.v1.when.scenario.read",
        "can.v1.when.scenario.trusted",
        "can.v1.when.scenario.periodic",
        "can.v1.when.scenario.cohort",
    ];
    let mut declarations = scenarios.to_vec();
    declarations.push("can.v1.when.crud");
    for (source, ids, section, guess) in [
        ("bogus\n".to_owned(), root.as_slice(), "root", "bogus"),
        (
            when("scenairo"),
            declarations.as_slice(),
            "When",
            "scenairo",
        ),
        (
            when("export scenairo"),
            scenarios.as_slice(),
            "When",
            "scenairo",
        ),
        (
            "app T\nGiven\n Item {name:text label={lable=\"Name\"}}\nWhen\nThen\n".to_owned(),
            ["can.v1.label.field"].as_slice(),
            "Given",
            "lable",
        ),
    ] {
        let output = parse(&source);
        let candidates = routing(&output);
        assert_eq!(candidates.len(), 1, "{source}: {output}");
        let candidate = candidates[0];
        assert_eq!(candidate["version"], 1);
        assert_eq!(candidate["disposition"], "exact", "{source}: {output}");
        assert_eq!(candidate["complete"], true);
        assert_eq!(
            candidate["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap().to_owned())
                .collect::<BTreeSet<_>>(),
            set(ids)
        );
        let context = &candidate["context"];
        assert_eq!(context["version"], 1);
        assert_eq!(context["section"], section);
        assert_eq!(context["guess"], guess);
        for flag in ["exactSourceSpan", "recoveryComplete", "nameFilterComplete"] {
            assert_eq!(context[flag], true, "{source}: {output}");
        }
        for flag in [
            "structuralRecovery",
            "evidenceSufficient",
            "unsupportedBehaviorProven",
        ] {
            assert_eq!(context[flag], false);
        }
        let diagnostic = output["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .find(|diagnostic| diagnostic.get("construct_candidates").is_some())
            .unwrap();
        let start = diagnostic["primary"]["start"].as_u64().unwrap() as usize;
        let end = diagnostic["primary"]["end"].as_u64().unwrap() as usize;
        assert_eq!(&source[start..end], guess);
    }
}

#[test]
fn same_codes_and_other_label_owners_do_not_invent_routing() {
    for source in [
        "app T\nWhen\nGiven\nThen\n",
        "app T\nGiven\n use Other\nWhen\nThen\n",
        "app T\nGiven\nWhen\n scenario run(\nThen\n",
        "app T\nGiven\n Item {name:text label={text=\"Name\"}\nWhen\nThen\n",
        "app T\nGiven\n Item {name:text} label={bad=\"x\"}\nWhen\nThen\n",
        "app T\nGiven\n Item {name:text}\nWhen\n crud Item by=members label={bad=\"x\"}\nThen\n",
        "app T\nGiven\n message word=\"Hi\"@{bad=1}\nWhen\nThen\n",
        "app T\nGiven\n Item {name:text @{bad=1}}\nWhen\nThen\n",
        "app T\nGiven\nWhen\nThen\n",
    ] {
        let output = parse(source);
        assert!(routing(&output).is_empty(), "{source}: {output}");
    }
}

#[test]
fn ambiguous_recovery_and_nonidentifier_spans_cannot_rank() {
    let long = "a".repeat(65);
    for source in [
        format!("{long}\n"),
        "échec\n".to_owned(),
        "42\n".to_owned(),
        "bogus\n child\n".to_owned(),
        when("bogus(\n"),
        when("export"),
        when("bogus; scenario run() by=members"),
        "app T\nGiven\n Item {name:text label={bad=\"Name\",\nWhen\nThen\n".to_owned(),
    ] {
        let output = parse(&source);
        for candidate in routing(&output) {
            assert_ne!(candidate["disposition"], "exact", "{source}: {output}");
            assert_eq!(candidate["complete"], false);
            assert_eq!(candidate["ids"], json!([]));
            assert!(candidate.get("context").is_none());
        }
    }
}

#[test]
fn cli_check_and_compile_refusals_keep_routing_without_modules() {
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("invalid.can");
    std::fs::write(&input, when("export scenairo")).unwrap();
    for command in ["check", "compile"] {
        let result = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json"])
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let output: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(result.status.code(), Some(10), "{output}");
        assert!(output.get("modules").is_none());
        let candidates = routing(&output);
        assert_eq!(candidates.len(), 1, "{output}");
        assert_eq!(candidates[0]["ids"].as_array().unwrap().len(), 5);
        assert_eq!(candidates[0]["context"]["guess"], "scenairo");
    }
}
