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

#[test]
fn dto_capacity_and_reached_body_require_borrow_only_original_successful_branch_rows() {
    let fields = (1..=16)
        .map(|i| format!("v{i}:int"))
        .collect::<Vec<_>>()
        .join(",");
    let entries = (1..=16)
        .map(|i| format!("v{i}=input.v{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let source = format!(
        "app Feasible\nGiven\n contract Input {{{fields}}}\n Run {{{fields}}}\n Intake {{source:text unique,input:Input,run:Run}}\n policy Run read=members\n policy Intake read=members\nWhen\n scenario pick(source:text,input:Input,a:bool,b:bool,c:bool,d:bool,e:bool,f:bool,g:bool) -> Run by=members\n  require a and b and c and d and e and f and g\n  do\n   let existing=first(Intake as prior where prior.source==source)\n   if existing!=null\n    require existing.input==input and g\n    return existing.run\n   create Run {{{entries}}} as run\n   create Intake {{source,input,run}} as intake\n   return run\nThen\n"
    );
    let (db, program, ir, catalog) = checked(&[("capacity-conditional-require.can", &source)]);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "Feasible.pick")
        .unwrap()
        .id;
    let ScenarioDisclosure::Complete(original) = &program.scenario_disclosures()[&owner] else {
        panic!("complete source");
    };
    assert_eq!(
        original.returns.len(),
        192,
        "complete original conservative inventory remains under the row bound"
    );
    assert!(
        requires_projection(original, &ir),
        "the actual DTO node bound requires projection even below 200 rows"
    );
    let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
    let selected = prepared
        .returns(&ir, owner)
        .expect("source-checked native subset");
    assert_eq!(
        selected.len(),
        2,
        "one existing and one fresh return; no skipped successful body And"
    );
    assert_ne!(selected[0].node, selected[1].node);
    for returned in &selected {
        assert!(
            original
                .returns
                .iter()
                .any(|row| std::ptr::eq(row, *returned))
        );
        assert!(
            returned
                .decisions
                .iter()
                .filter(|decision| decision.node.kind == SyntaxKind::Binary as u8)
                .all(|decision| decision.choice == DisclosureChoice::RhsEvaluated)
        );
    }
    let body_site = original
        .source_facts
        .as_ref()
        .unwrap()
        .decision_sites
        .as_ref()
        .unwrap()
        .iter()
        .find(|site| site.stage == CheckedDecisionStage::BodyRequire)
        .unwrap();
    let fresh = selected
        .iter()
        .find(|returned| {
            returned.node.start > body_site.statement.end
                && !returned
                    .decisions
                    .iter()
                    .any(|decision| decision.node == body_site.node)
        })
        .unwrap();
    assert!(
        !fresh
            .decisions
            .iter()
            .any(|decision| decision.node == body_site.node),
        "unreached body requirement stays unobserved"
    );
    let discarded = original
        .returns
        .iter()
        .position(|returned| !selected.iter().any(|row| row.id == returned.id))
        .unwrap();
    for mode in [
        "body-condition",
        "site-position",
        "discarded-choice",
        "field-name",
    ] {
        let mut changed = ir.clone();
        match mode {
            "body-condition" => {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!("scenario")
                };
                let IrStmt::If { then_branch, .. } = &mut effects[1] else {
                    panic!("first nonnull branch")
                };
                let IrStmt::Require { cond, .. } = &mut then_branch[0] else {
                    panic!("body require")
                };
                cond.expr = IrExpr::Bool(true);
            }
            "field-name" => {
                changed
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "Feasible.Run.v16")
                    .unwrap()
                    .name = "foreign".into()
            }
            _ => {
                let ScenarioDisclosure::Complete(proof) =
                    changed.scenario_disclosures.get_mut(&owner).unwrap()
                else {
                    panic!("complete")
                };
                if mode == "discarded-choice" {
                    proof.returns[discarded].decisions.clear();
                } else {
                    *proof
                        .source_facts
                        .as_mut()
                        .unwrap()
                        .decision_sites
                        .as_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|site| site.stage == CheckedDecisionStage::BodyRequire)
                        .unwrap()
                        .position
                        .last_mut()
                        .unwrap() = CheckedDecisionPosition::Then(1);
                }
            }
        }
        assert!(
            prepare(&program, &changed, &db, Some(&catalog))
                .as_ref()
                .and_then(|prepared| prepared.returns(&changed, owner))
                .is_none(),
            "{mode} remains sealed before pruning"
        );
    }
    assert_eq!(original.returns.len(), 192);
}

#[test]
fn bounded_independent_scalar_require_paths_keep_the_existing_unprojected_inventory() {
    let (db, program, ir, catalog) = checked(&[(
        "bounded-independent.can",
        "app Independent\nGiven\nWhen\n scenario probe(a:bool,b:bool) -> int by=members\n  require a and b\n  do return 9\nThen\n",
    )]);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "Independent.probe")
        .unwrap()
        .id;
    let ScenarioDisclosure::Complete(original) = &program.scenario_disclosures()[&owner] else {
        panic!("complete scalar")
    };
    assert!(!requires_projection(original, &ir));
    assert!(
        original
            .returns
            .iter()
            .all(|row| row.dependencies.is_empty() && row.intrinsics.is_empty())
    );
    let prepared = prepare(&program, &ir, &db, Some(&catalog)).unwrap();
    let selected = prepared.returns(&ir, owner).unwrap();
    assert_eq!(selected.len(), original.returns.len());
    assert!(
        selected
            .iter()
            .zip(&original.returns)
            .all(|(selected, original)| std::ptr::eq(*selected, original))
    );
}
