//! Selected checked bindings through actual public compilation and installed
//! facades. Direct getter inputs qualify expression order, not canonical input
//! admission. Localized formatting requires a qualified handler scope;
//! broader presentation sinks and serving remain separately scoped.
#![cfg(unix)]

use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir;
use canlang_compiler::source::{SourceDb, SourceId, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

#[test]
fn production_selected_calls_execute_actual_facades() {
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script = scratch.path().join("probe.mjs");
    std::fs::write(&script, include_str!("fixtures/selected-call-consumer.mjs")).unwrap();
    let output = Command::new("node")
        .arg(script)
        .arg(root())
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .output()
        .expect("Node required for actual facade qualification");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    eprintln!("{stdout}");
}

#[test]
fn missing_checked_binding_has_no_catalog_reconstruction_fallback() {
    let mut db = SourceDb::new();
    let id = db.add(
        "selected.can".into(),
        "app T\nGiven\n derive g():text = lower(value=\"HI\")\nWhen\nThen\n".into(),
    );
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(SourceId(0), 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (mut checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.selected_calls.len(), 1);
    checked.types.selected_calls.clear();
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let emitted = canlang_compiler::codegen::js::emit_program(&ir);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diag| diag.code == "E6008"
                && diag.message.contains("checked selected-call binding")),
        "{:?}",
        emitted.diagnostics
    );
}

#[test]
fn disjoint_same_arity_names_require_one_owning_overload() {
    let scratch = tempfile::tempdir().unwrap();
    let catalog_path = scratch.path().join("catalog.json");
    std::fs::write(&catalog_path, r#"{
        "language_version":"1.0","catalog_version":"disjoint-name-control",
        "entries":[{"id":"starts_with","kind":"builtin","js":"starts_with",
        "owner":"test","effects":"pure","availability":"implemented",
        "signature":"starts_with(value:text,prefix:text)->bool; starts_with(text:text,start:text)->bool"}]
    }"#).unwrap();
    let source =
        "app T\nGiven\n derive g():bool = starts_with(value=\"AB\",start=\"A\")\nWhen\nThen\n";
    let input = scratch.path().join("mixed.can");
    std::fs::write(&input, source).unwrap();
    let mut db = SourceDb::new();
    let id = db.add(input.display().to_string(), source.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: scratch.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.expect("both overloads must be admitted");
    assert_eq!(catalog.overloads("starts_with").unwrap().len(), 2);
    let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0].code, "E3005");
    assert!(diagnostics[0].message.contains("no overload"));
    let call_start = source.find("starts_with(").unwrap();
    assert_eq!(diagnostics[0].primary.start as usize, call_start);
    assert_eq!(
        &source[diagnostics[0].primary.start as usize..diagnostics[0].primary.end as usize],
        "starts_with(value=\"AB\",start=\"A\")"
    );
    assert!(checked.types.selected_calls.is_empty());
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(&catalog_path)
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(10),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(artifact["diagnostics"].as_array().unwrap().len(), 1);
    assert_eq!(artifact["diagnostics"][0]["code"], "E3005");
    assert!(artifact.get("modules").is_none());
}

#[test]
fn nominal_catalog_deferral_preserves_actual_checked_arguments() {
    use canlang_compiler::analysis::catalog::Availability;
    use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};

    let scratch = tempfile::tempdir().unwrap();
    for (name, nominal, source, unresolved) in [
        (
            "declared",
            "Box",
            "app T\nGiven\n contract Box { label:text }\n derive g(value:Box):bool = starts_with(value,\"A\")\nWhen\nThen\n",
            false,
        ),
        (
            "deferred",
            "MisspelledBox",
            "app T\nGiven\n derive g():bool = starts_with(7,\"A\")\nWhen\nThen\n",
            false,
        ),
        (
            "unresolved",
            "MisspelledBox",
            "app T\nGiven\n derive g():bool = starts_with(missing,\"A\")\nWhen\nThen\n",
            true,
        ),
    ] {
        let catalog_path = scratch.path().join(format!("{name}.catalog.json"));
        std::fs::write(&catalog_path, format!(r#"{{"language_version":"1.0","catalog_version":"nominal-deferral-control","entries":[{{"id":"starts_with","kind":"builtin","js":"starts_with","owner":"test","effects":"pure","availability":"implemented","signature":"starts_with(value:{nominal},prefix:text)->bool"}}]}}"#)).unwrap();
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, source).unwrap();
        let mut db = SourceDb::new();
        let id = db.add(input.display().to_string(), source.into());
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&catalog_path),
            env: None,
            cwd: scratch.path(),
            primary: Span::new(id, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{name}: {diagnostics:?}");
        let catalog = catalog.unwrap();
        // Availability comes only from the explicit catalog entry. Nominal
        // deferral neither establishes a deployment nor validates a value.
        assert_eq!(
            catalog.availability("starts_with"),
            Some(Availability::Implemented)
        );
        let (checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
        assert!(
            checked
                .modules
                .iter()
                .all(|module| module.imports.is_empty())
        );
        assert!(checked.types.target_bindings.is_empty());
        if unresolved {
            assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
            assert_eq!(diagnostics[0].code, "E2001");
        } else {
            assert!(diagnostics.is_empty(), "{name}: {diagnostics:?}");
            assert_eq!(checked.types.selected_calls.len(), 1);
            let (call_key, selected) = checked.types.selected_calls.iter().next().unwrap();
            assert!(
                matches!(&selected.target, SelectedCallTarget::Builtin { id, overload:0 } if id=="starts_with")
            );
            assert_eq!(selected.slots, [Some(0), Some(1)]);
            assert_eq!(
                checked.types.node_types[call_key],
                ResolvedType::Scalar(Scalar::Bool)
            );
            let actual = &checked.types.node_types[&selected.arguments[0]];
            if name == "declared" {
                let ResolvedType::Record { symbol, .. } = actual else {
                    panic!("actual contract argument: {actual:?}")
                };
                assert_eq!(checked.symbols[symbol.0 as usize].canonical, "T.Box");
                assert!(matches!(
                    checked.symbols[symbol.0 as usize].kind,
                    canlang_compiler::analysis::resolve::SymbolKind::Contract { .. }
                ));
                let declaration = checked
                    .symbols
                    .iter()
                    .find(|item| item.canonical == "T.g")
                    .unwrap();
                let canlang_compiler::analysis::resolve::SymbolKind::DeriveFn { params, .. } =
                    &declaration.kind
                else {
                    panic!("owning derive declaration")
                };
                assert_eq!(
                    actual, &checked.types.symbol_types[&params[0]],
                    "nominal deferral retains the owning parameter type"
                );
            } else {
                assert_eq!(*actual, ResolvedType::Scalar(Scalar::Int));
                assert!(!checked.symbols.iter().any(|symbol| symbol.name == nominal));
            }
        }
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["check", "--format=json", "--catalog"])
            .arg(&catalog_path)
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .current_dir(scratch.path())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(if unresolved { 10 } else { 0 }),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let cli_diagnostics = result["diagnostics"].as_array().unwrap();
        if unresolved {
            assert_eq!(cli_diagnostics.len(), 1);
            assert_eq!(cli_diagnostics[0]["code"], "E2001");
        } else {
            assert!(cli_diagnostics.is_empty());
        }
    }
}
