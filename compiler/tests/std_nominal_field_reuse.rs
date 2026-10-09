//! Standard nominal field reuse through the actual canonical enum input codec.
#![cfg(unix)]

use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog, nominal_schema};
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::types::ResolvedType;
use canlang_compiler::codegen::ir::{self, IrItemKind, IrType};
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::syntax::cst::SyntaxKind;
use std::{path::Path, process::Command};

#[test]
fn std_nominal_field_reuse_preserves_delivery_status_enum_and_native_inputs() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/std-nominal-field-reuse.can");
    let input = scratch.path().join("std-nominal-field-reuse.can");
    std::fs::write(&input, source).unwrap();
    let mut db = SourceDb::new();
    let id = db.add(input.display().to_string(), source.into());
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let status = nominal_schema("DeliveryResult")
        .unwrap()
        .fields
        .iter()
        .find(|(name, _)| *name == "status")
        .unwrap()
        .1;
    let cases: Vec<String> = status
        .strip_prefix("enum(")
        .unwrap()
        .strip_suffix(')')
        .unwrap()
        .split(',')
        .map(str::to_string)
        .collect();
    assert_eq!(cases.len(), 5);
    let scenario = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "NominalFieldReuse.accept")
        .unwrap();
    let parameter = checked.effects.scenarios[&scenario.id].params[0].param;
    assert!(
        matches!(&checked.types.symbol_types[&parameter], ResolvedType::Enum { cases: actual, .. } if actual == &cases)
    );
    let field = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "NominalFieldReuse.Entry.state")
        .unwrap();
    assert!(
        matches!(&checked.types.symbol_types[&field.id], ResolvedType::Enum { cases: actual, .. } if actual == &cases)
    );
    let (_, delivery_type) = checked
        .types
        .node_types
        .iter()
        .find(|(key, _)| {
            key.kind == SyntaxKind::Member as u8
                && source[key.start as usize..key.end as usize].trim()
                    == "entry.notification?.status"
        })
        .expect("checked safe delivery member, including its CST-owned leading trivia");
    assert!(matches!(delivery_type, ResolvedType::Nullable(inner)
        if matches!(inner.as_ref(), ResolvedType::Enum { cases: actual, .. } if actual == &cases)));
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let copy = ir
        .items
        .iter()
        .find(|item| item.canonical == "NominalFieldReuse.copy")
        .unwrap();
    assert!(
        matches!(&copy.kind, IrItemKind::DeriveFn { result:IrType::Known(ResolvedType::Enum { cases: actual, .. }), .. } if actual == &cases)
    );

    let compile = |path: &Path| {
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(&catalog_path)
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(&input);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let executed = Command::new("node")
        .arg(root.join("compiler/tests/fixtures/std-nominal-field-reuse-consumer.mjs"))
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));

    let nonnull = scratch.path().join("nonnull-delivery.can");
    std::fs::write(
        &nonnull,
        source.replace("delivery(Mail.send)?", "delivery(Mail.send)"),
    )
    .unwrap();
    let refused = compile(&nonnull);
    assert_eq!(refused.status.code(), Some(10));
    let response: serde_json::Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert!(
        response["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E3008")
    );
    assert!(response.get("modules").is_none());
    let missing = scratch.path().join("missing-published-field.can");
    std::fs::write(
        &missing,
        source.replacen("Report.status", "Report.absent", 1),
    )
    .unwrap();
    let refused = compile(&missing);
    assert_eq!(refused.status.code(), Some(10));
    let response: serde_json::Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert!(
        response["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E2013")
    );
    assert!(response.get("modules").is_none());
}
