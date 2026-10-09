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

// Each compiler proof names this test and its exact owning fixture construct.
// Runtime/page/example execution is intentionally absent from this compiler half.
const FIRST_PROFILE_SOURCE: &str = include_str!("fixtures/construct-help-first-profile.can");
const FIRST_PROFILE_LOCATIONS: &[(&str, &str, syntax::SyntaxKind)] = &[
    (
        "can.v1.app.implicit",
        "app HelpOffice",
        syntax::SyntaxKind::App,
    ),
    ("can.v1.section.given", "Given", syntax::SyntaxKind::Section),
    ("can.v1.section.when", "When", syntax::SyntaxKind::Section),
    ("can.v1.section.then", "Then", syntax::SyntaxKind::Section),
    ("can.v1.model", "Supply {", syntax::SyntaxKind::Model),
    (
        "can.v1.schema",
        "Supply {name:text",
        syntax::SyntaxKind::Model,
    ),
    ("can.v1.field", "name:text trim", syntax::SyntaxKind::Field),
    (
        "can.v1.field.default",
        "available:bool=true",
        syntax::SyntaxKind::Field,
    ),
    (
        "can.v1.field.trim",
        "name:text trim",
        syntax::SyntaxKind::Field,
    ),
    ("can.v1.field.min", "min=1", syntax::SyntaxKind::Field),
    ("can.v1.field.max", "max=160", syntax::SyntaxKind::Field),
    (
        "can.v1.type.nullable",
        "int?",
        syntax::SyntaxKind::NullableType,
    ),
    (
        "can.v1.type.enum",
        "enum(all,available)",
        syntax::SyntaxKind::EnumType,
    ),
    (
        "can.v1.type.builtin.text",
        "name:text trim",
        syntax::SyntaxKind::Field,
    ),
    (
        "can.v1.type.builtin.int",
        "stock:int=0",
        syntax::SyntaxKind::Field,
    ),
    (
        "can.v1.type.builtin.bool",
        "available:bool=true",
        syntax::SyntaxKind::Field,
    ),
    (
        "can.v1.policy",
        "policy Supply read=members",
        syntax::SyntaxKind::Policy,
    ),
    (
        "can.v1.invariant",
        "invariant Supply: row.stock>=0",
        syntax::SyntaxKind::Invariant,
    ),
    (
        "can.v1.lock",
        "lock Supply fields=name when=row.locked",
        syntax::SyntaxKind::Lock,
    ),
    (
        "can.v1.derive.function",
        "derive heading():text",
        syntax::SyntaxKind::Derive,
    ),
    (
        "can.v1.fixture.model",
        "fixture editable=Supply",
        syntax::SyntaxKind::Fixture,
    ),
    (
        "can.v1.fixture.user",
        "fixture person=user",
        syntax::SyntaxKind::Fixture,
    ),
    (
        "can.v1.when.crud",
        "crud Supply by=members",
        syntax::SyntaxKind::Crud,
    ),
    (
        "can.v1.when.scenario.user",
        "scenario rename(",
        syntax::SyntaxKind::Scenario,
    ),
    (
        "can.v1.when.scenario.read",
        "scenario total() read=true",
        syntax::SyntaxKind::Scenario,
    ),
    (
        "can.v1.examples.table.crud",
        "examples update record=editable",
        syntax::SyntaxKind::Examples,
    ),
    (
        "can.v1.examples.table.scenario",
        "examples seed=[editable] supply=editable",
        syntax::SyntaxKind::Examples,
    ),
    (
        "can.v1.examples.table.error",
        "outsider,\"Private change\",9 -> error(forbidden)",
        syntax::SyntaxKind::ExampleRow,
    ),
    (
        "can.v1.then.preferences-schema",
        "preferences {view:",
        syntax::SyntaxKind::Preferences,
    ),
    (
        "can.v1.then.page",
        "page / title=\"Office supplies\"",
        syntax::SyntaxKind::Page,
    ),
    (
        "can.v1.then.form",
        "form Supply.create",
        syntax::SyntaxKind::Form,
    ),
    (
        "can.v1.then.edit",
        "edit fields=name,quantity,available",
        syntax::SyntaxKind::Edit,
    ),
    ("can.v1.then.delete", "delete\n", syntax::SyntaxKind::UiLeaf),
    (
        "can.v1.then.text",
        "text row.name,row.quantity,row.available",
        syntax::SyntaxKind::UiLeaf,
    ),
    (
        "can.v1.ui.card",
        "card \"Add a supply\"",
        syntax::SyntaxKind::Card,
    ),
    (
        "can.v1.ui.input",
        "input name",
        syntax::SyntaxKind::CatalogItem,
    ),
    (
        "can.v1.ui.tabs-selector",
        "tabs preferences.view",
        syntax::SyntaxKind::Tabs,
    ),
    (
        "can.v1.ui.list",
        "list Supply as supply",
        syntax::SyntaxKind::Collection,
    ),
    (
        "can.v1.ui.table",
        "table Supply columns=",
        syntax::SyntaxKind::Collection,
    ),
    (
        "can.v1.ui.stat",
        "stat count(Supply)",
        syntax::SyntaxKind::CatalogItem,
    ),
    (
        "can.v1.builtin.count",
        "count(Supply)",
        syntax::SyntaxKind::Call,
    ),
];

fn profile_cli(command: &str, source: &str) -> (std::process::Output, Value) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("first-profile.can");
    std::fs::write(&input, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([command, "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let value = serde_json::from_slice(&output.stdout).expect("CLI JSON output");
    (output, value)
}

#[test]
fn first_profile_compiler_cards_have_checked_source_and_emitted_owners() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let consumer =
        std::fs::read_to_string(root.join("packages/cloudflare/src/dev/construct-help.ts"))
            .unwrap();
    let inventory = consumer
        .split("const FIRST_PROFILE_IDS = new Set([")
        .nth(1)
        .unwrap()
        .split("]);\n")
        .next()
        .unwrap();
    let ids: BTreeSet<_> = inventory
        .split('"')
        .filter(|part| part.starts_with("can.v1."))
        .collect();
    assert_eq!(
        ids,
        FIRST_PROFILE_LOCATIONS
            .iter()
            .map(|(id, _, _)| *id)
            .collect()
    );
    let (tree, diagnostics) = syntax::parse_source(SourceId(0), FIRST_PROFILE_SOURCE);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut nodes = Vec::new();
    let mut pending = vec![&tree];
    while let Some(node) = pending.pop() {
        nodes.push(node);
        pending.extend(node.children.iter());
    }
    for (id, anchor, kind) in FIRST_PROFILE_LOCATIONS {
        let start = FIRST_PROFILE_SOURCE
            .find(anchor)
            .unwrap_or_else(|| panic!("missing card construct {id}"));
        assert!(
            nodes.iter().any(|node| node.kind == *kind
                && node.span.start as usize <= start
                && start + anchor.trim_end().len() <= node.span.end as usize),
            "compiler/tests/construct_help.rs::first_profile_compiler_cards_have_checked_source_and_emitted_owners[{id}] has no owning {kind:?} at {start}"
        );
    }
    let (checked, check) = profile_cli("check", FIRST_PROFILE_SOURCE);
    assert!(
        checked.status.success(),
        "{check}\n{}",
        String::from_utf8_lossy(&checked.stderr)
    );
    assert!(routing(&check).is_empty());
    let (compiled, artifact) = profile_cli("compile", FIRST_PROFILE_SOURCE);
    assert!(
        compiled.status.success(),
        "{artifact}\n{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    assert_eq!(artifact["pages"].as_array().unwrap().len(), 1);
    assert_eq!(artifact["pages"][0]["owner"], "HelpOffice");
    assert_eq!(artifact["pages"][0]["path"], "/");
    let model = artifact["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["name"] == "HelpOffice.Supply")
        .unwrap();
    let fields = model["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 5);
    let name = fields.iter().find(|field| field["name"] == "name").unwrap();
    assert_eq!(name["field"]["kind"], "string");
    assert_eq!(name["trim"], true);
    let available = fields
        .iter()
        .find(|field| field["name"] == "available")
        .unwrap();
    assert_eq!(available["field"]["kind"], "boolean");
    assert_eq!(available["default"], json!({"kind":"literal","value":true}));
    assert_eq!(
        fields
            .iter()
            .find(|field| field["name"] == "quantity")
            .unwrap()["nullable"],
        true
    );
    let operations = artifact["operations"].as_array().unwrap();
    for operation in [
        "HelpOffice.Supply.create",
        "HelpOffice.Supply.update",
        "HelpOffice.Supply.delete",
        "HelpOffice.rename",
        "HelpOffice.total",
    ] {
        assert!(
            operations.iter().any(|entry| entry["name"] == operation),
            "{operation}"
        );
    }
    assert_eq!(
        operations
            .iter()
            .find(|entry| entry["name"] == "HelpOffice.total")
            .unwrap()["result"]["type"],
        "int"
    );
    let js = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for retained in [
        "trim:true",
        "min:1n",
        "max:160n",
        "require.1",
        "lock.1",
        "preferences",
        "columns:[\"name\",\"stock\",\"available\"]",
    ] {
        assert!(
            js.contains(retained),
            "actual emitted metadata missing {retained}"
        );
    }
    for factory in ["form", "input", "tabs", "list", "table", "stat", "card"] {
        let marker = format!("{factory} as ");
        let alias = js
            .split(&marker)
            .nth(1)
            .unwrap_or_else(|| panic!("missing owning UI import {factory}"))
            .split(|ch: char| ch == ',' || ch == '}' || ch.is_whitespace())
            .next()
            .unwrap();
        assert!(
            js.contains(&format!("{alias}(")),
            "imported factory {factory} must actually be called by emitted page"
        );
    }
    let tests = artifact["tests"].as_array().unwrap();
    assert!(!tests.is_empty());
    let examples = tests
        .iter()
        .map(|test| test["module"]["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for retained in [
        "exampleFixtures",
        "error:\"forbidden\"",
        "expected:async",
        "observations:[",
        "roles:",
    ] {
        assert!(
            examples.contains(retained),
            "actual emitted examples missing {retained}"
        );
    }
    for fixture in ["HelpOffice.editable", "HelpOffice.person"] {
        assert!(
            tests
                .iter()
                .flat_map(|test| test["fixtures"].as_array().unwrap())
                .any(|emitted| emitted == fixture),
            "missing emitted fixture recipe {fixture}"
        );
    }
    assert!(
        !js.contains("exampleFixtures"),
        "test-only fixtures stay outside production modules"
    );
}

#[test]
fn first_profile_compiler_half_refuses_invalid_types_fields_and_ui_options() {
    for source in [
        FIRST_PROFILE_SOURCE.replace("row.stock>=0", "row.stock>=\"zero\""),
        FIRST_PROFILE_SOURCE.replace(
            "set supply {name=accepted}",
            "set supply {missing=accepted}",
        ),
        FIRST_PROFILE_SOURCE.replace("stat count(Supply)", "stat count(Supply) unexplained=true"),
        FIRST_PROFILE_SOURCE.replace(
            "empty=\"No stock\"",
            "empty=\"No stock\"\n    text row.name",
        ),
    ] {
        let (compiled, output) = profile_cli("compile", &source);
        assert!(
            !compiled.status.success(),
            "invalid source must refuse: {source}\n{output}"
        );
        assert!(output.get("modules").is_none(), "{output}");
        assert!(
            output["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["severity"] == "error"),
            "{output}"
        );
    }
}
