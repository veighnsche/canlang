//! Authored table ordering through the released installed query carrier.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir::{self, IrExpr};
use canlang_compiler::source::{SourceDb, Span};
use std::{path::Path, process::Command};

const SOURCE: &str = include_str!("fixtures/table-order.can");

#[test]
fn checked_table_orders_reach_the_original_native_query_and_protected_row() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("table-order.can".into(), SOURCE.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let children = &program.modules[0].pages[0].render[0].children;
    let tables = children
        .iter()
        .filter(|node| node.factory == "table")
        .collect::<Vec<_>>();
    assert_eq!(tables.len(), 3);
    for (table, expected) in tables.iter().zip([
        vec!["from"],
        vec!["-from", "rank", "day"],
        vec!["rank", "-day"],
    ]) {
        let IrExpr::Array(order) = &table
            .props
            .iter()
            .find(|(key, _)| key == "order")
            .unwrap()
            .1
            .expr
        else {
            panic!("checked selector order");
        };
        assert_eq!(
            order
                .iter()
                .map(|value| match &value.expr {
                    IrExpr::Text(value) => value.as_str(),
                    _ => panic!("canonical signed selector"),
                })
                .collect::<Vec<_>>(),
            expected
        );
        assert!(table.props.iter().any(|(key, _)| key == "parent"));
    }
    assert_eq!(
        tables[1]
            .children
            .iter()
            .map(|node| node.factory.as_str())
            .collect::<Vec<_>>(),
        ["text", "form", "form"]
    );
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("table-order.can");
    std::fs::write(&input, SOURCE).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(&catalog_path)
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumed =
        Command::new("node")
            .arg(root.join(
                "docs/implementation/compiler-completion/view-reuse/table-order-consumer.mjs",
            ))
            .arg(root)
            .arg(&artifact)
            .arg(scratch.path().join("staged"))
            .current_dir(root)
            .output()
            .unwrap();
    assert!(
        consumed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&consumed.stdout));
}

#[test]
fn preference_dispatched_order_lowers_to_case_ternary() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let source = SOURCE
        .replacen(
            "order=from",
            "order={by=preferences.ordering,default=[from],cases={ascending=[from],descending=[-from]}}",
            1,
        )
        .replace(
            "Then\n",
            "Then\n preferences {ordering:enum(ascending,descending)=ascending}\n",
        );
    let mut db = SourceDb::new();
    let id = db.add("table-order-dispatched.can".into(), source.clone());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let children = &program.modules[0].pages[0].render[0].children;
    let table = children
        .iter()
        .find(|node| node.factory == "table")
        .expect("dispatched table");
    let IrExpr::Object(entries) = &table
        .props
        .iter()
        .find(|(key, _)| key == "order")
        .unwrap()
        .1
        .expr
    else {
        panic!("dispatched order object");
    };
    let entry = |key: &str| {
        entries
            .iter()
            .find(|(name, _)| name == key)
            .unwrap_or_else(|| panic!("order entry {key}"))
            .1
            .clone()
    };
    let texts = |value: &canlang_compiler::codegen::ir::TypedExpr| match &value.expr {
        IrExpr::Array(items) => items
            .iter()
            .map(|item| match &item.expr {
                IrExpr::Text(text) => text.clone(),
                _ => panic!("canonical signed selector"),
            })
            .collect::<Vec<_>>(),
        _ => panic!("canonical order array"),
    };
    match &entry("by").expr {
        IrExpr::Member { base, field } => {
            assert!(matches!(&base.expr, IrExpr::Name(name) if name == "preferences"));
            assert_eq!(field, "ordering");
        }
        _ => panic!("preference member read"),
    }
    assert_eq!(texts(&entry("default")), vec!["from"]);
    let IrExpr::Object(cases) = &entry("cases").expr else {
        panic!("dispatched order cases");
    };
    let case = |key: &str| {
        texts(
            &cases
                .iter()
                .find(|(name, _)| name == key)
                .unwrap_or_else(|| panic!("order case {key}"))
                .1,
        )
    };
    assert_eq!(case("ascending"), vec!["from"]);
    assert_eq!(case("descending"), vec!["-from"]);
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("table-order-dispatched.can");
    std::fs::write(&input, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(&catalog_path)
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = String::from_utf8_lossy(&compiled.stdout);
    assert!(
        artifact.contains("order:(preferences.ordering==="),
        "dispatch ternary: {artifact}",
    );
    assert!(
        artifact.contains("const preferences="),
        "preferences preamble: {artifact}",
    );
}

#[test]
fn malformed_or_unreleased_table_controls_cannot_publish() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    for (name, replacement, expected) in [
        ("unknown", "order=missing", None),
        ("bare", "order", None),
        ("foreign", "order=Calendar.title", None),
        ("enum-order", "order=state", Some("E3006")),
        (
            "dispatched-unknown-case",
            "order={by=preferences.ordering,default=[from],cases={ascending=[from],sideways=[from]}}",
            Some("E3006"),
        ),
        (
            "dispatched-bad-selector",
            "order={by=preferences.ordering,default=[from],cases={ascending=[missing]}}",
            Some("E2013"),
        ),
        (
            "dispatched-bad-by",
            "order={by=row.title,default=[from],cases={ascending=[from]}}",
            Some("E3001"),
        ),
        (
            "dispatched-unordered-key",
            "order={by=preferences.ordering,default=[from],cases={ascending=[state]}}",
            Some("E3006"),
        ),
        (
            "nonenum-filter",
            "order=from filter=available defaults={available=true}",
            Some("E6008"),
        ),
    ] {
        let mut source = SOURCE.replacen("order=from", replacement, 1);
        if name.starts_with("dispatched") {
            source = source.replace(
                "Then\n",
                "Then\n preferences {ordering:enum(ascending,descending)=ascending}\n",
            );
        }
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let diagnostics = result["diagnostics"].as_array().unwrap();
        assert!(!diagnostics.is_empty(), "{name}");
        if let Some(code) = expected {
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == code),
                "{name}: {diagnostics:?}"
            );
        }
        assert!(
            result.get("modules").is_none(),
            "{name}: refused source cannot publish"
        );
    }
}
