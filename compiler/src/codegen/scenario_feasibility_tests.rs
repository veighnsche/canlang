use super::*;
use crate::analysis::catalog::{CatalogRequest, load_catalog};
use crate::analysis::check_program;
use std::path::Path;

fn checked(sources: &[(&str, &str)]) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let files = sources
        .iter()
        .map(|(name, text)| db.add((*name).into(), (*text).into()))
        .collect::<Vec<_>>();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let path = root
        .parent()
        .unwrap()
        .join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &files, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

#[test]
fn original_require_feasibility_retains_source_paths_and_refuses_discarded_path_corruption() {
    let (db, program, ir, catalog) = checked(&[
        (
            "CanChat.can",
            include_str!("../../tests/fixtures/original-a850/CanChat.can"),
        ),
        (
            "CanCreative.can",
            include_str!("../../tests/fixtures/original-a850/CanCreative.can"),
        ),
    ]);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "chat.ask")
        .unwrap()
        .id;
    let ScenarioDisclosure::Complete(original) = &program.scenario_disclosures()[&owner] else {
        panic!("original source complete")
    };
    assert_eq!(original.returns.len(), 256);
    let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
    let selected = prepared
        .returns(&ir, owner)
        .expect("authenticated native subset");
    assert_eq!(selected.len(), 1);
    assert!(
        original
            .returns
            .iter()
            .any(|row| std::ptr::eq(row, selected[0]))
    );
    assert_eq!(
        ir.scenario_disclosures[&owner]
            .source_facts()
            .unwrap()
            .queries
            .as_deref()
            .unwrap()
            .len(),
        4
    );
    let copy = ir.clone();
    assert!(
        prepared.returns(&copy, owner).is_none(),
        "private preparation belongs to the same immutable IR"
    );
    let discarded = original
        .returns
        .iter()
        .position(|row| row.id != selected[0].id)
        .unwrap();
    for mode in [
        "dependency",
        "decision",
        "source",
        "loss",
        "guard",
        "schema",
        "schema-name",
    ] {
        let mut changed = ir.clone();
        if matches!(mode, "schema" | "schema-name") {
            let field = changed
                .items
                .iter_mut()
                .find(|item| item.canonical == "chat.Run.cancellation")
                .unwrap();
            if mode == "schema-name" {
                field.name = "foreign_cancellation".into();
            } else {
                let IrItemKind::Field { ty, .. } = &mut field.kind else {
                    panic!("full original field")
                };
                *ty = IrType::Known(ResolvedType::Scalar(Scalar::Int));
            }
        } else if mode == "guard" {
            let IrItemKind::Scenario { guards, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            let IrStmt::Require { cond, .. } = &mut guards[0] else {
                panic!("guard")
            };
            cond.expr = IrExpr::Bool(true);
        } else if mode == "loss" {
            changed.scenario_disclosures.remove(&owner);
        } else {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("proof")
            };
            let row = &mut proof.returns[discarded];
            match mode {
                "dependency" => row.dependencies.clear(),
                "decision" => row.decisions.clear(),
                "source" => row.source.sha256 = "0".repeat(64),
                _ => unreachable!(),
            }
        }
        let result = prepare(&program, &changed, &db, Some(&catalog));
        assert!(
            result
                .as_ref()
                .and_then(|value| value.returns(&changed, owner))
                .is_none(),
            "{mode}: even discarded source paths remain sealed"
        );
    }
    assert_eq!(original.returns.len(), 256);
}

#[test]
fn current_revision_native_subset_borrows_the_original_success_path() {
    let (db, program, ir, catalog) = checked(&[(
        "current-revision.can",
        include_str!("../../tests/fixtures/source-current-revision.can"),
    )]);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "SourceCurrentRevision.generate")
        .unwrap()
        .id;
    let ScenarioDisclosure::Complete(original) = &program.scenario_disclosures()[&owner] else {
        panic!("original source complete")
    };
    assert_eq!(original.returns.len(), 4);
    let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
    let selected = prepared.returns(&ir, owner).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(
        selected[0].id,
        "79d0c5b24994f46af0206a4d6076165d075c65e6e63272c97ce6f2f47d5d08dd"
    );
    assert!(
        original
            .returns
            .iter()
            .any(|row| std::ptr::eq(row, selected[0]))
    );
    assert_eq!(original.returns.len(), 4);
}
