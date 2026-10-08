//! Finite source-reaching FAIL-R06 controls; each depth runs in a bounded child.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::types::SelectedCallTarget;
use canlang_compiler::analysis::{ResolvedType, Scalar, check_program};
use canlang_compiler::source::{SourceDb, Span};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn bounded_cases(name: &str, depths: &[usize], run: impl Fn(usize)) {
    if let Ok(depth) = std::env::var("CAN_WIDTH_BOUNDARY_DEPTH") {
        run(depth.parse().unwrap());
        return;
    }
    for &depth in depths {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("output");
        let errors = dir.path().join("errors");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env("CAN_WIDTH_BOUNDARY_DEPTH", depth.to_string())
            .stdout(Stdio::from(std::fs::File::create(&output).unwrap()))
            .stderr(Stdio::from(std::fs::File::create(&errors).unwrap()))
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("{name} depth {depth} exceeded child supervision deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(
            status.success(),
            "{name} depth {depth}: {status}\n{}{}",
            std::fs::read_to_string(output).unwrap(),
            std::fs::read_to_string(errors).unwrap()
        );
    }
}

fn catalog(depth: usize) -> Catalog {
    // An explicit test producer, loaded through the actual catalog boundary.
    // Nullable postfixes force successful matching and specificity traversal
    // through every wrapper without adding authored expression nesting.
    let signature = format!("depth_probe(value:int{})->int", "?".repeat(depth));
    let document = serde_json::json!({
        "language_version": "1.0",
        "catalog_version": "width-boundaries-test",
        "entries": [{
            "id": "depth_probe", "js": "depthProbe", "owner": "width-test-producer",
            "kind": "builtin", "signature": signature,
            "effects": "pure", "availability": "implemented"
        }]
    });
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    std::fs::write(&path, document.to_string()).unwrap();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: dir.path(),
        primary: Span::new(canlang_compiler::source::SourceId(0), 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    assert_eq!(
        catalog.lookup("depth_probe").unwrap().owner,
        "width-test-producer"
    );
    catalog
}

#[test]
fn used_catalog_postfix_shapes_match_through_every_wrapper() {
    bounded_cases(
        "used_catalog_postfix_shapes_match_through_every_wrapper",
        &[0, 16, 32, 64, 128],
        |depth| {
            let catalog = catalog(depth);
            let mut db = SourceDb::new();
            let source = db.add(
            "accepted.can".into(),
            "app Width\nGiven\n derive accepted(value:int): int = depth_probe(value)\nWhen\nThen\n".into(),
        );
            let (program, diagnostics) = check_program(&db, &[source], Some(&catalog));
            assert!(diagnostics.is_empty(), "depth {depth}: {diagnostics:?}");
            assert_eq!(program.checked_files(), &[source]);
            assert_eq!(program.catalog_version, "width-boundaries-test");
            assert_eq!(program.types.selected_calls.len(), 1);
            let selected = program.types.selected_calls.values().next().unwrap();
            assert!(
                matches!(&selected.target, SelectedCallTarget::Builtin { id, overload: 0 } if id == "depth_probe")
            );
            let wrong = db.add(
            "rejected.can".into(),
            "app Width\nGiven\n derive rejected(value:bool): int = depth_probe(value)\nWhen\nThen\n".into(),
        );
            let (_, diagnostics) = check_program(&db, &[wrong], Some(&catalog));
            assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
            assert_eq!(diagnostics[0].code, "E3005");
            assert!(
                diagnostics[0]
                    .message
                    .contains("no overload of 'depth_probe' matches")
            );
        },
    );
}

#[test]
fn acyclic_field_reuse_resolves_forward_chain() {
    bounded_cases(
        "acyclic_field_reuse_resolves_forward_chain",
        &[0, 16, 32, 64, 128],
        |depth| {
            let catalog = catalog(0);
            let mut text = String::from("app Width\nGiven\n");
            // Declare the referring field first so resolution must follow the
            // complete chain, rather than reusing already checked predecessor types.
            for i in 0..depth {
                text.push_str(&format!(" F{i} {{ value:F{}.value }}\n", i + 1));
            }
            text.push_str(&format!(" F{depth} {{ value:int }}\n"));
            for i in 0..=depth {
                text.push_str(&format!(" policy F{i} read=members\n"));
            }
            text.push_str(" derive observed(value:F0.value): int = value\nWhen\nThen\n");
            let mut db = SourceDb::new();
            let source = db.add("reuse.can".into(), text);
            let (program, diagnostics) = check_program(&db, &[source], Some(&catalog));
            assert!(diagnostics.is_empty(), "depth {depth}: {diagnostics:?}");
            assert_eq!(program.checked_files(), &[source]);
            for i in 0..=depth {
                let canonical = format!("Width.F{i}.value");
                let symbol = program
                    .symbols
                    .iter()
                    .find(|symbol| symbol.canonical == canonical)
                    .unwrap();
                assert_eq!(
                    program.types.symbol_types[&symbol.id],
                    ResolvedType::Scalar(Scalar::Int)
                );
            }
        },
    );
}

#[test]
fn cyclic_field_reuse_reports_e3008() {
    bounded_cases("cyclic_field_reuse_reports_e3008", &[0], |_| {
        let catalog = catalog(0);
        let mut db = SourceDb::new();
        for (body, paths) in [
            (
                " F0 { value:F0.value }\n policy F0 read=members\n",
                vec!["F0.value"],
            ),
            (
                " Upstream { value:F0.value }\n F0 { value:F1.value }\n F1 { value:F0.value }\n Good { value:int }\n policy Upstream read=members\n policy F0 read=members\n policy F1 read=members\n policy Good read=members\n",
                vec!["F1.value", "F0.value"],
            ),
        ] {
            let text = format!("app Width\nGiven\n{body}When\nThen\n");
            let cycle = db.add("cycle.can".into(), text.clone());
            let (program, diagnostics) = check_program(&db, &[cycle], Some(&catalog));
            assert_eq!(diagnostics.len(), paths.len(), "{diagnostics:?}");
            for (diagnostic, path) in diagnostics.iter().zip(paths) {
                assert_eq!(diagnostic.code, "E3008");
                assert_eq!(
                    diagnostic.message,
                    "cyclic field-type reuse through 'value'"
                );
                // The last occurrence excludes the acyclic upstream reference.
                let start = text.rfind(path).unwrap() as u32;
                assert_eq!(
                    diagnostic.primary,
                    Span::new(cycle, start, start + path.len() as u32)
                );
            }
            if body.contains(" Good ") {
                let good = program
                    .symbols
                    .iter()
                    .find(|symbol| symbol.canonical == "Width.Good.value")
                    .unwrap();
                assert_eq!(
                    program.types.symbol_types[&good.id],
                    ResolvedType::Scalar(Scalar::Int)
                );
            }
        }
    });
}
