//! Private source correspondence and optional DTO transport, not native query execution.
use super::*;
use crate::analysis::catalog::{CatalogRequest, load_catalog};
use crate::analysis::check_program;
use crate::analysis::scenario_disclosure::DisclosureDependency;
use std::path::Path;

const SOURCE: &str = include_str!("../../tests/fixtures/native-ancestor-count.can");
const OWNER: &str = "AncestorCount.ask";

fn fixture() -> (SourceDb, IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add("native-ancestor-count.can".into(), SOURCE.into());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = super::super::ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, ir)
}

fn owner(ir: &IrProgram) -> &IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == OWNER)
        .unwrap()
}

fn symbol(ir: &IrProgram, name: &str) -> crate::analysis::SymbolId {
    ir.items
        .iter()
        .find(|item| item.canonical == name)
        .unwrap()
        .id
}

// Borrow only actual nodes from the authored count guard. Looking in effects
// too lets the negative stage test retain the exact moved expression pointer.
fn operands(ir: &IrProgram) -> (&TypedExpr, &TypedExpr, &TypedExpr) {
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner(ir).kind
    else {
        panic!("scenario")
    };
    let cond = guards
        .iter()
        .chain(effects)
        .find_map(|statement| match statement {
            IrStmt::Require { cond, .. }
                if matches!(
                    cond.expr,
                    IrExpr::Binary {
                        op: IrBinOp::Lt,
                        ..
                    }
                ) =>
            {
                Some(cond)
            }
            _ => None,
        })
        .unwrap();
    let IrExpr::Binary { left: call, .. } = &cond.expr else {
        panic!("count comparison")
    };
    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &call.expr else {
        panic!("count")
    };
    let IrExpr::Query(query) = &args[0].expr else {
        panic!("actual query")
    };
    let IrExpr::Binary {
        left: equality,
        right: unfinished,
        ..
    } = &query.where_pred.as_ref().unwrap().expr
    else {
        panic!("predicate")
    };
    let IrExpr::Binary {
        left: candidate,
        right: supplied,
        ..
    } = &equality.expr
    else {
        panic!("ancestor equality")
    };
    (candidate, supplied, unfinished)
}

fn reads(ir: &IrProgram) -> [&DisclosureDependency; 2] {
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&owner(ir).id] else {
        panic!("source Complete")
    };
    let [candidate, supplied] = proof.returns[0].dependencies.as_slice() else {
        panic!("two original ordinary parent reads")
    };
    [candidate, supplied]
}

#[test]
fn actual_candidate_and_supplied_occurrences_share_query_but_keep_distinct_parent_reads() {
    let (db, ir) = fixture();
    let item = owner(&ir);
    let (candidate, supplied, foreign) = operands(&ir);
    let [candidate_read, supplied_read] = reads(&ir);
    assert_ne!(candidate_read.id, supplied_read.id);
    assert_ne!(candidate_read.node, supplied_read.node);
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&item.id] else {
        panic!("Complete")
    };
    let facts = proof.source_facts.as_ref().unwrap();
    let [query] = facts.queries.as_ref().unwrap().as_slice() else {
        panic!("one original query")
    };
    assert_eq!(
        query
            .dependencies
            .iter()
            .map(|dependency| dependency.field_name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "unfinished"]
    );
    assert!(
        query
            .dependencies
            .iter()
            .all(|dependency| dependency.query_id.is_none())
    );
    for (read, expression, source_text) in [
        (candidate_read, candidate, "run.parent.parent"),
        (supplied_read, supplied, "branch.parent"),
    ] {
        assert_eq!(read.role, DependencyRole::Control);
        assert_eq!(read.field_name, "parent");
        assert_eq!(read.query_id.as_deref(), Some(query.id.as_str()));
        assert_eq!(
            db.get(read.node.file).unwrap().text[read.node.start as usize..read.node.end as usize]
                .trim(),
            source_text
        );
        let (child, parent, id) =
            checked_candidate_parent_association(&ir, item, read, expression, &db)
                .expect("authentic borrowed source parent occurrence");
        assert_eq!(id, query.id);
        assert_eq!(child.canonical, "AncestorCount.Branch");
        assert_eq!(parent.canonical, "AncestorCount.Conversation");
        assert_eq!(child.parent, Some(parent.id));
        assert_eq!(child.source, query.source);
        assert_eq!(parent.source, query.source);
        assert_eq!(read.field, child.id);
        assert_eq!(read.model, child.id);
        assert_eq!(
            read.ty,
            ResolvedType::Record {
                symbol: parent.id,
                stored: true
            }
        );
    }
    assert!(
        checked_candidate_parent_association(&ir, item, candidate_read, foreign, &db).is_none(),
        "ordinary unfinished node cannot stand in for parent"
    );
    let detached = candidate.clone();
    assert_eq!(detached.span, candidate.span);
    assert!(
        checked_candidate_parent_association(&ir, item, candidate_read, &detached, &db).is_none(),
        "same-span detached clone is not the actual consumed occurrence"
    );
    let foreign_ir = ir.clone();
    let (foreign_candidate, _, _) = operands(&foreign_ir);
    assert_eq!(foreign_candidate.span, candidate.span);
    assert!(
        checked_candidate_parent_association(&ir, item, candidate_read, foreign_candidate, &db)
            .is_none(),
        "borrowed node from another IR is foreign"
    );
    let mut unassociated = candidate_read.clone();
    unassociated.query_id = None;
    assert!(
        checked_candidate_parent_association(&ir, item, &unassociated, candidate, &db).is_none()
    );
}

#[test]
fn source_query_consumption_slots_schema_and_guard_stage_mutations_refuse_parent_association() {
    let (db, ir) = fixture();
    for mode in [
        "source-hash",
        "query-id",
        "source-node",
        "influence-consumption",
        "parent-marker",
        "bound",
        "alias",
        "query-domain",
        "slot",
        "type",
        "child-owner",
        "parameter-index",
        "guard-stage",
    ] {
        let mut changed = ir.clone();
        let id = owner(&changed).id;
        if matches!(
            mode,
            "source-hash" | "query-id" | "source-node" | "influence-consumption" | "parent-marker"
        ) {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&id).unwrap()
            else {
                panic!("Complete")
            };
            match mode {
                "source-hash" => {
                    proof.source_facts.as_mut().unwrap().source.sha256 = "0".repeat(64)
                }
                "query-id" => {
                    proof.returns[0].dependencies[0].query_id = Some("foreign-query".into())
                }
                "source-node" => {
                    proof
                        .source_facts
                        .as_mut()
                        .unwrap()
                        .queries
                        .as_mut()
                        .unwrap()[0]
                        .node
                        .end -= 1
                }
                "parent-marker" => {
                    proof
                        .source_facts
                        .as_mut()
                        .unwrap()
                        .queries
                        .as_mut()
                        .unwrap()[0]
                        .dependencies
                        .remove(0);
                }
                _ => {
                    proof.returns[0].influences.pop().unwrap();
                }
            }
        } else if mode == "child-owner" {
            let branch = symbol(&changed, "AncestorCount.Branch");
            let IrItemKind::Model { owner, .. } = &mut changed.items[branch.0 as usize].kind else {
                panic!("model")
            };
            *owner = IrOwner::Team;
        } else if mode == "parameter-index" {
            let IrItemKind::Scenario { params, .. } = &owner(&changed).kind else {
                panic!("scenario")
            };
            let parameter = params[0];
            let IrItemKind::Param { index, .. } = &mut changed.items[parameter.0 as usize].kind
            else {
                panic!("parameter")
            };
            *index += 1;
        } else {
            let IrItemKind::Scenario {
                guards, effects, ..
            } = &mut changed.items[id.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "guard-stage" {
                effects.insert(0, guards.remove(0));
            } else {
                let IrStmt::Require { cond, .. } = &mut guards[0] else {
                    panic!("leading guard")
                };
                let IrExpr::Binary {
                    left: call,
                    right: bound,
                    ..
                } = &mut cond.expr
                else {
                    panic!("count comparison")
                };
                if mode == "bound" {
                    bound.expr = IrExpr::Int(9);
                } else if mode == "slot" {
                    let (IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. }) =
                        &call.expr
                    else {
                        panic!("count")
                    };
                    call.expr = IrExpr::BoundCall {
                        target: target.clone(),
                        args: args.clone(),
                        slots: vec![None],
                    };
                } else {
                    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) =
                        &mut call.expr
                    else {
                        panic!("count")
                    };
                    let IrExpr::Query(query) = &mut args[0].expr else {
                        panic!("query")
                    };
                    match mode {
                        "alias" => {
                            let crate::analysis::types::CheckedQueryClauseKind::As { name } =
                                &mut query.source.as_mut().unwrap().clauses[0].kind
                            else {
                                panic!("alias")
                            };
                            *name = "foreign".into();
                        }
                        "query-domain" => {
                            query.source.as_mut().unwrap().domain =
                                query.source.as_ref().unwrap().node
                        }
                        _ => {
                            let IrExpr::Binary { left: equality, .. } =
                                &mut query.where_pred.as_mut().unwrap().expr
                            else {
                                panic!("predicate")
                            };
                            let IrExpr::Binary {
                                left: candidate, ..
                            } = &mut equality.expr
                            else {
                                panic!("equality")
                            };
                            candidate.ty = ResolvedType::Scalar(Scalar::Text);
                        }
                    }
                }
            }
        }
        let (candidate, supplied, _) = operands(&changed);
        let [candidate_read, supplied_read] = reads(&changed);
        for (read, expression) in [(candidate_read, candidate), (supplied_read, supplied)] {
            // The query-ID mutation changes one occurrence; its untouched
            // companion remains independently eligible for the same query.
            if mode == "query-id" && std::ptr::eq(read, supplied_read) {
                continue;
            }
            assert!(
                checked_candidate_parent_association(
                    &changed,
                    owner(&changed),
                    read,
                    expression,
                    &db
                )
                .is_none(),
                "{mode}"
            );
        }
    }
    let mut stale = SourceDb::new();
    stale.add(
        "native-ancestor-count.can".into(),
        SOURCE.replace("unfinished=true", "unfinished=false"),
    );
    let (candidate, supplied, _) = operands(&ir);
    let [candidate_read, supplied_read] = reads(&ir);
    for (read, expression) in [(candidate_read, candidate), (supplied_read, supplied)] {
        assert!(
            checked_candidate_parent_association(&ir, owner(&ir), read, expression, &stale)
                .is_none(),
            "stale owning source"
        );
    }
}

#[test]
fn associated_receipt_dependency_transports_query_id_and_ordinary_reads_omit_it() {
    let (db, ir) = fixture();
    let (candidate, _, _) = operands(&ir);
    let [read, _] = reads(&ir);
    let (_, _, query_id) =
        checked_candidate_parent_association(&ir, owner(&ir), read, candidate, &db).unwrap();
    let mut transported = ReceiptDependency {
        id: read.id.clone(),
        source: transport_source(&read.source, "ancestor-count.mjs").unwrap(),
        role: ReceiptRole::Control,
        model: read.model_name.clone(),
        field: read.field_name.clone(),
        type_id: read.type_id.clone(),
        query_id: Some(query_id.into()),
    };
    let associated = serde_json::to_value(&transported).unwrap();
    assert_eq!(associated["queryId"], query_id);
    assert_eq!(associated["id"], read.id);
    assert_eq!(associated["model"], "AncestorCount.Branch");
    assert_eq!(associated["field"], "parent");
    assert_eq!(associated["type"], "AncestorCount.Conversation");
    assert_eq!(associated["role"], "control");
    transported.query_id = None;
    let ordinary = serde_json::to_value(&transported).unwrap();
    assert!(ordinary.get("queryId").is_none());
    let mut expected = associated;
    expected.as_object_mut().unwrap().remove("queryId");
    assert_eq!(ordinary, expected);
    // This exercises only the defining optional serialization field. The
    // unscoped native facade and actual candidate/store authority are external.
}
