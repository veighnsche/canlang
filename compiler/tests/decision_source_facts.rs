//! Checked decision source correspondence only; existing purity gates remain.
use canlang_compiler::{
    analysis::{
        CheckedProgram,
        catalog::{CatalogRequest, load_catalog},
        check_program,
        scenario_disclosure::{
            CheckedDecisionCallTarget, CheckedDecisionPosition, CheckedDecisionStage,
        },
    },
    diagnostic::Diagnostic,
    source::{SourceDb, Span},
};

fn check(sources: &[(&str, &str)]) -> (SourceDb, CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let files = sources
        .iter()
        .map(|(path, text)| db.add((*path).into(), (*text).into()))
        .collect::<Vec<_>>();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &files, catalog.as_ref());
    (db, program, diagnostics)
}

#[test]
fn imported_query_decisions_join_actual_query_collection_and_predicate_sources() {
    use canlang_compiler::codegen::{
        ir::{self, IrExpr, IrItemKind, IrQueryDomain, IrStmt},
        scenario_decisions::{collect_decision_sources, serialize_decision_sources},
    };
    let source = "app QueryDecision\nuse employee {Employee,staff}\nGiven\nWhen\n scenario run(person:user) by=members\n  require staff(person)\n  do require count(Employee as e where e.active)>0\nThen\n";
    let helper = "package employee\n Given\n  export Employee {user:user,active:bool=false,rank:int=0}\n  OtherEmployee {user:user,active:bool=false}\n  policy Employee read=members\n  policy OtherEmployee read=members\n  export derive staff(person:user):bool = any(Employee as e,abs(e.rank)>0 and e.user==person and e.active)\n When\n Then\n";
    let (db, initial, diagnostics) =
        check(&[("query-decision.can", source), ("employee.can", helper)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(initial.checked_files()[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, initial.checked_files(), catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "QueryDecision.run")
        .unwrap()
        .id;
    let helper_id = lowered
        .items
        .iter()
        .find(|item| item.canonical == "employee.staff")
        .unwrap()
        .id;
    let other_model = lowered
        .items
        .iter()
        .find(|item| item.canonical == "employee.OtherEmployee")
        .unwrap()
        .id;
    let sites = collect_decision_sources(
        &program,
        &lowered,
        &lowered.items[owner.0 as usize],
        &db,
        catalog.as_ref(),
    )
    .expect("actual pure query decisions retain source correspondence");
    assert_eq!(sites.len(), 2);
    assert_eq!(sites[0].stage, CheckedDecisionStage::LeadingRequire);
    assert_eq!(sites[1].stage, CheckedDecisionStage::BodyRequire);
    assert!(
        matches!(sites[0].calls[0].target,CheckedDecisionCallTarget::DeriveFn(id) if id==helper_id)
    );
    let any = sites[0]
        .calls
        .iter()
        .find(|call| matches!(&call.target,CheckedDecisionCallTarget::Builtin{id,..} if id=="any"))
        .unwrap();
    assert_eq!(any.source.module, "employee");
    assert_eq!(any.chain.len(), 1);
    assert_eq!(any.chain[0].derive, helper_id);
    assert_eq!(any.slots, vec![Some(0), Some(1)]);
    let predicate_call = sites[0]
        .calls
        .iter()
        .find(|call| matches!(&call.target,CheckedDecisionCallTarget::Builtin{id,..} if id=="abs"))
        .unwrap();
    assert_eq!(predicate_call.source.module, "employee");
    assert_eq!(predicate_call.source.path, "employee.can");
    assert_eq!(predicate_call.chain.len(), 1);
    assert_eq!(predicate_call.chain[0].derive, helper_id);
    assert_eq!(predicate_call.chain[0].node, sites[0].calls[0].node);
    assert_eq!(predicate_call.chain[0].source.path, "query-decision.can");
    assert_eq!(predicate_call.slots, vec![Some(0)]);
    assert_eq!(sites[0].calls.len(), 3);
    assert_eq!(sites[0].calls[1].node, predicate_call.node);
    assert_eq!(sites[0].calls[2].node, any.node);
    let argument_text = |node: canlang_compiler::analysis::NodeKey| {
        let file = db.get(node.file).unwrap();
        file.text[node.start as usize..node.end as usize].to_owned()
    };
    assert_eq!(
        predicate_call
            .arguments
            .iter()
            .map(|(node, _)| argument_text(*node))
            .collect::<Vec<_>>(),
        vec!["e.rank"]
    );
    assert_eq!(
        predicate_call.arguments[0].1,
        canlang_compiler::analysis::types::ResolvedType::Scalar(
            canlang_compiler::analysis::types::Scalar::Int
        )
    );
    let IrItemKind::DeriveFn {
        expr: Some(body), ..
    } = &lowered.items[helper_id.0 as usize].kind
    else {
        panic!("actual derive")
    };
    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &body.expr else {
        panic!("actual any")
    };
    let IrExpr::Query(query) = &args[0].expr else {
        panic!("actual model query")
    };
    let query_fact = query.source.as_deref().unwrap();
    let collection = query.collection_call.as_ref().unwrap();
    assert_eq!(program.types.checked_queries[&query_fact.node], *query_fact);
    assert_eq!(
        program.types.checked_collection_calls[&collection.node],
        **collection
    );
    assert_eq!(collection.query, query_fact.node);
    assert_eq!(collection.builtin, "any");
    assert!(
        query.where_pred.is_none(),
        "external predicate is not an authored where clause"
    );
    let IrExpr::Lambda {
        param,
        body: predicate,
    } = &args[1].expr
    else {
        panic!("actual external predicate")
    };
    assert_eq!(param, "e");
    assert_eq!(
        collection.predicate.as_ref().unwrap().node.start,
        predicate.span.start
    );
    let json = serde_json::to_value(
        serialize_decision_sources(
            &program,
            &lowered,
            &lowered.items[owner.0 as usize],
            &db,
            catalog.as_ref(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        json[0]["calls"][0]["target"],
        serde_json::json!({"kind":"derive","name":"employee.staff"})
    );
    assert_eq!(json[0]["calls"][1]["target"]["id"], "abs");
    let serial_any = json[0]["calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|call| call["target"]["id"] == "any")
        .unwrap();
    assert_eq!(serial_any["arguments"][0]["type"], "employee.Employee[]");
    assert_eq!(serial_any["arguments"][1]["type"], "bool");
    assert_eq!(json[1]["calls"][0]["target"]["id"], "count");
    for corruption in 0..11 {
        let mut changed = lowered.clone();
        if corruption == 10 {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!()
            };
            let IrStmt::Require { cond, .. } = &mut effects[0] else {
                panic!()
            };
            let IrExpr::Binary { left, .. } = &mut cond.expr else {
                panic!()
            };
            let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut left.expr
            else {
                panic!()
            };
            let IrExpr::Query(query) = &mut args[0].expr else {
                panic!()
            };
            query.where_pred.as_mut().unwrap().expr = IrExpr::Bool(false);
        } else {
            let IrItemKind::DeriveFn {
                expr: Some(body), ..
            } = &mut changed.items[helper_id.0 as usize].kind
            else {
                panic!()
            };
            let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut body.expr
            else {
                panic!()
            };
            if corruption == 9 {
                args[1].expr = IrExpr::Bool(true);
            } else if corruption >= 7 {
                let IrExpr::Lambda { param, body } = &mut args[1].expr else {
                    panic!()
                };
                match corruption {
                    7 => *param = "foreign".into(),
                    _ => body.expr = IrExpr::Bool(false),
                }
            } else {
                let IrExpr::Query(query) = &mut args[0].expr else {
                    panic!()
                };
                match corruption {
                    0 => query.source = None,
                    1 => query.collection_call = None,
                    2 => {
                        let node = query.source.as_ref().unwrap().node;
                        query.source.as_mut().unwrap().domain = node;
                    }
                    3 => query.collection_call.as_mut().unwrap().model = other_model,
                    4 => {
                        query.collection_call.as_mut().unwrap().alias =
                            query.source.as_ref().unwrap().node
                    }
                    5 => query.domain = IrQueryDomain::Model("employee.OtherEmployee".into()),
                    _ => {
                        query
                            .collection_call
                            .as_mut()
                            .unwrap()
                            .predicate
                            .as_mut()
                            .unwrap()
                            .node
                            .start += 1
                    }
                }
            }
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                catalog.as_ref()
            )
            .is_none(),
            "query corruption {corruption}"
        );
        assert!(
            serialize_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                catalog.as_ref()
            )
            .is_none(),
            "serial query corruption {corruption}"
        );
    }
    let async_helper=helper.replace("  export derive staff", "  derive same(person:user,candidate:user):bool = person==candidate\n  export derive staff").replace("abs(e.rank)>0 and e.user==person", "same(e.user,person)");
    let (async_db, async_initial, diagnostics) = check(&[
        ("query-decision.can", source),
        ("employee.can", &async_helper),
    ]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (async_program, diagnostics) =
        check_program(&async_db, async_initial.checked_files(), catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (async_ir, diagnostics) = ir::build(&async_program, &async_db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let output = canlang_compiler::codegen::js::emit_program(&async_ir);
    assert!(
        output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message
                    == "cannot lower scoped predicate: Values any/all require a synchronous predicate"),
        "an awaited derive collection predicate remains unsupported: {:?}",
        output.diagnostics
    );
}

#[test]
fn imported_pure_helpers_preserve_decision_sites_slots_defaults_and_chains() {
    let source = "app DecisionFacts\nuse helpers {acceptable}\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\nWhen\n scenario run(person:user,a:int,b:int) by=members\n  require acceptable(last=b,first=a)\n  do\n   require active_member(person,team) and active_member(person,team)\n   if a>0\n    require acceptable(first=a)\n   send LLM.cancel {revision=1,source=\"fixed\"} when=acceptable(first=a,last=b) as stop\nThen\n";
    let helper = "package helpers\n Given\n  export derive acceptable(first:int,last:int=abs(-2)):bool = first>0 and last>0\n When\n Then\n";
    let (db, program, diagnostics) = check(&[("decisions.can", source), ("helpers.can", helper)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let scenario = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "DecisionFacts.run")
        .unwrap()
        .id;
    let source_facts = program.scenario_disclosures()[&scenario]
        .source_facts()
        .unwrap();
    let sites = source_facts.decision_sites.as_ref().unwrap();
    assert_eq!(sites.len(), 5);
    assert_eq!(
        sites.iter().map(|site| site.stage).collect::<Vec<_>>(),
        vec![
            CheckedDecisionStage::LeadingRequire,
            CheckedDecisionStage::BodyRequire,
            CheckedDecisionStage::BodyCondition,
            CheckedDecisionStage::BodyRequire,
            CheckedDecisionStage::SendDispatch
        ]
    );
    assert_eq!(sites[0].position, vec![CheckedDecisionPosition::Guard(0)]);
    assert_eq!(
        sites[3].position,
        vec![
            CheckedDecisionPosition::Body(1),
            CheckedDecisionPosition::Then(0)
        ]
    );
    for site in sites {
        assert_eq!(site.owner, scenario);
        assert_eq!(site.source.path, "decisions.can");
        assert!(site.node.start >= site.statement.start && site.node.end <= site.statement.end);
    }
    let named = &sites[0].calls[0];
    assert!(matches!(
        named.target,
        CheckedDecisionCallTarget::DeriveFn(_)
    ));
    assert_eq!(named.slots, vec![Some(1), Some(0)]);
    let text = |node: canlang_compiler::analysis::NodeKey| {
        let file = db.get(node.file).unwrap();
        file.text[node.start as usize..node.end as usize].to_owned()
    };
    assert_eq!(
        named
            .arguments
            .iter()
            .map(|(node, _)| text(*node))
            .collect::<Vec<_>>(),
        vec!["b", "a"]
    );
    assert!(named.defaults.is_empty());
    assert_eq!(sites[1].calls.len(), 2);
    assert_ne!(sites[1].calls[0].node, sites[1].calls[1].node);
    let membership = &sites[1].calls[0];
    assert!(
        matches!(&membership.target,CheckedDecisionCallTarget::Builtin{id,..} if id=="active_member")
    );
    assert_eq!(membership.slots, vec![Some(0), Some(1)]);
    assert_eq!(
        membership
            .arguments
            .iter()
            .map(|(node, _)| text(*node))
            .collect::<Vec<_>>(),
        vec!["person", "team"]
    );
    let omitted = &sites[3].calls[0];
    assert_eq!(omitted.slots, vec![Some(0), None]);
    assert_eq!(omitted.defaults.len(), 1);
    assert_eq!(text(omitted.defaults[0].1), "abs(-2)");
    let default_call = &sites[3].calls[1];
    assert!(matches!(&default_call.target,CheckedDecisionCallTarget::Builtin{id,..} if id=="abs"));
    assert_eq!(default_call.source.path, "helpers.can");
    assert_eq!(default_call.chain.len(), 1);
    assert_eq!(default_call.chain[0].node, omitted.node);
    assert_eq!(default_call.chain[0].source.path, "decisions.can");
    assert!(sites[4].calls.iter().all(|call| call.defaults.is_empty()));
}

#[test]
fn unsupported_selected_role_declines_only_optional_decision_inventory() {
    let source = "app RoleDecision\nGiven\n role reviewer label=\"Reviewer\"\nWhen\n scenario run(person:user) by=members\n  do require reviewer(person)\nThen\n";
    let (_, program, diagnostics) = check(&[("role.can", source)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let scenario = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "RoleDecision.run")
        .unwrap()
        .id;
    assert!(
        program.scenario_disclosures()[&scenario]
            .source_facts()
            .unwrap()
            .decision_sites
            .is_none()
    );
}

#[test]
fn bounded_membership_sources_preserve_strict_default_and_other_state_read_refusals() {
    for source in [
        "app PureGate\nGiven\n derive member(person:user):bool = active_member(person,team)\nWhen\nThen\n",
        "app PureGate\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\nWhen\n scenario run(person:user) by=members\n  do send LLM.cancel {revision=1,source=\"fixed\"} when=active_member(person,team) as stop\nThen\n",
    ] {
        let (_, program, diagnostics) = check(&[("pure-gate.can", source)]);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(program.effects.derives.len() + program.effects.scenarios.len() > 0);
    }
    let source = "app PureGate\nGiven\nWhen\n scenario run(person:user,allowed:bool=active_member(person,team)) by=members\n  do let accepted=allowed\nThen\n";
    let (_, program, diagnostics) = check(&[("strict-default.can", source)]);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3011"),
        "{diagnostics:?}"
    );
    assert!(program.scenario_disclosures().is_empty());

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let catalog_path = scratch.path().join("other-state-read.json");
    let original_catalog =
        std::fs::read_to_string(root.join("packages/values/dist/catalog.json")).unwrap();
    std::fs::write(
        &catalog_path,
        original_catalog.replace("active_member", "other_member"),
    )
    .unwrap();
    let mut db = SourceDb::new();
    let source = "app OtherRead\nGiven\n derive member(person:user):bool=other_member(person,team)\nWhen\nThen\n";
    let file = db.add("other-state-read.can".into(), source.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3010"),
        "{diagnostics:?}"
    );
    assert!(
        program.scenario_disclosures().is_empty(),
        "unclean source has no checked scenario facts"
    );
}

#[test]
fn trusted_body_condition_and_read_policies_preserve_original_sites_and_refuse_ir_edits() {
    use canlang_compiler::{
        analysis::scenario_disclosure::ScenarioDisclosure,
        codegen::{
            ir::{self, IrCallTarget, IrExpr, IrItemKind, IrStmt},
            scenario_decisions::{
                collect_decision_sources, serialize_decision_sources,
                serialize_read_decision_sources,
            },
        },
    };
    let source = "app HandlerDecision\nGiven\n Entry {person:user,enabled:bool=false}\n event Received {person:user}\n derive member(person:user):bool=active_member(person,team)\n derive other(person:user):bool=true\n policy Entry read=member(row.person) where=member(row.person)\n policy Entry read=members where=row.enabled\nWhen\n scenario changed on=Received\n  do\n   if member(event.person)\n    let accepted=true\nThen\n";
    let (db, initial, diagnostics) = check(&[("handler-decision.can", source)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(initial.checked_files()[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, initial.checked_files(), catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "HandlerDecision.changed")
        .unwrap()
        .id;
    assert!(matches!(
        program.scenario_disclosures()[&owner],
        ScenarioDisclosure::Declined(_)
    ));
    let sites = collect_decision_sources(
        &program,
        &lowered,
        &lowered.items[owner.0 as usize],
        &db,
        catalog.as_ref(),
    )
    .unwrap();
    assert_eq!(sites.len(), 1);
    assert_eq!(sites[0].stage, CheckedDecisionStage::BodyCondition);
    assert_eq!(sites[0].position, vec![CheckedDecisionPosition::Body(0)]);
    assert_eq!(
        source[sites[0].node.start as usize..sites[0].node.end as usize].trim(),
        "member(event.person)"
    );
    assert_eq!(sites[0].calls.len(), 2);
    assert!(
        matches!(&sites[0].calls[1].target, CheckedDecisionCallTarget::Builtin { id, .. } if id == "active_member")
    );
    assert_eq!(sites[0].calls[1].chain.len(), 1);
    assert_eq!(sites[0].calls[1].chain[0].node, sites[0].calls[0].node);
    let json = serde_json::to_value(
        serialize_decision_sources(
            &program,
            &lowered,
            &lowered.items[owner.0 as usize],
            &db,
            catalog.as_ref(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(json[0]["stage"], "body-condition");
    assert_eq!(json[0]["calls"][1]["arguments"][0]["type"], "user");
    assert_eq!(json[0]["calls"][1]["arguments"][1]["type"], "Team");
    for mutation in 0..4 {
        let mut changed = lowered.clone();
        let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
            panic!()
        };
        let IrStmt::If { cond, span, .. } = &mut effects[0] else {
            panic!()
        };
        match mutation {
            0 => cond.expr = IrExpr::Bool(false),
            1 => cond.span.start += 1,
            2 => span.start += 1,
            _ => {
                let IrExpr::Call { target, .. } = &mut cond.expr else {
                    panic!()
                };
                *target = IrCallTarget::DeriveFn("HandlerDecision.other".into());
            }
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                catalog.as_ref()
            )
            .is_none(),
            "condition mutation {mutation}"
        );
    }
    let rule = lowered
        .read_rules
        .iter()
        .find(|rule| rule.id == "Entry.read.1")
        .unwrap();
    let policy_sites =
        serialize_read_decision_sources(&program, &lowered, rule, &db, catalog.as_ref()).unwrap();
    let policy = serde_json::to_value(&policy_sites).unwrap();
    assert_eq!(policy_sites.len(), 2);
    for site in policy.as_array().unwrap() {
        assert_eq!(site["stage"], "read-policy");
        assert_eq!(site["owner"], "HandlerDecision.Entry.read.1");
        assert_eq!(site["position"], serde_json::json!([]));
        assert_eq!(site["calls"].as_array().unwrap().len(), 2);
        assert_eq!(site["calls"][1]["arguments"][1]["type"], "Team");
    }
    assert!(policy_sites[0].node.start < policy_sites[1].node.start);
    let shorthand = lowered
        .read_rules
        .iter()
        .find(|rule| rule.id == "Entry.read.2")
        .unwrap();
    let shorthand =
        serialize_read_decision_sources(&program, &lowered, shorthand, &db, catalog.as_ref())
            .unwrap();
    assert_eq!(shorthand.len(), 2);
    assert!(shorthand.iter().all(|site| site.calls.is_empty()));
    for mutation in 0..4 {
        let mut changed = lowered.clone();
        let index = changed
            .read_rules
            .iter()
            .position(|candidate| candidate.id == rule.id)
            .unwrap();
        let altered = &mut changed.read_rules[index];
        match mutation {
            0 => altered.pred.expr = IrExpr::Bool(false),
            1 => altered.pred.span.start += 1,
            2 => altered.span.start += 1,
            _ => {
                let IrExpr::Binary { right, .. } = &mut altered.pred.expr else {
                    panic!()
                };
                let IrExpr::Call { target, .. } = &mut right.expr else {
                    panic!()
                };
                *target = IrCallTarget::DeriveFn("HandlerDecision.other".into());
            }
        }
        assert!(
            serialize_read_decision_sources(
                &program,
                &changed,
                &changed.read_rules[index],
                &db,
                catalog.as_ref()
            )
            .is_none(),
            "policy mutation {mutation}"
        );
    }
}

#[test]
fn actual_ir_decisions_join_defaults_and_refuse_corrupt_proofs() {
    use canlang_compiler::{
        analysis::scenario_disclosure::ScenarioDisclosure,
        codegen::{ir, scenario_decisions::collect_decision_sources},
    };
    let source = "app DecisionJoin\nuse helpers {good}\nGiven\nWhen\n scenario run(a:int,b:int) by=members\n  require good(last=b,first=a)\n  do\n   if a>0\n    require (good(first=a))\nThen\n";
    let helper = "package helpers\n Given\n  export derive good(first:int,last:int=abs(-2)):bool = first>0 and last>0\n When\n Then\n";
    let (db, initial, diagnostics) = check(&[("join.can", source), ("helpers.can", helper)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (cat, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(diagnostics.is_empty());
    let (program, diagnostics) = check_program(&db, initial.checked_files(), cat.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, cat.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "DecisionJoin.run")
        .unwrap();
    assert_eq!(
        collect_decision_sources(&program, &lowered, owner, &db, cat.as_ref())
            .unwrap()
            .len(),
        3
    );
    for corruption in 0..11 {
        let mut changed = lowered.clone();
        let facts = match changed.scenario_disclosures.get_mut(&owner.id).unwrap() {
            ScenarioDisclosure::Complete(v) => v.source_facts.as_mut().unwrap(),
            ScenarioDisclosure::Declined(v) => v.source_facts.as_mut().unwrap(),
        };
        let sites = facts.decision_sites.as_mut().unwrap();
        match corruption {
            0 => {
                sites.pop();
            }
            1 => sites[0].owner = canlang_compiler::analysis::resolve::SymbolId(u32::MAX),
            2 => sites[0].stage = CheckedDecisionStage::BodyRequire,
            3 => sites[0].position = vec![CheckedDecisionPosition::Body(0)],
            4 => sites[0].source.sha256 = "0".repeat(64),
            5 => sites[0].calls[0].source.module = "foreign".into(),
            6 => sites[0].calls[0].slots = vec![Some(0), Some(0)],
            7 => sites[0].calls[0].arguments[0].0.start += 1,
            8 => sites[2].calls[0].defaults.clear(),
            9 => sites[2].calls[1].chain.clear(),
            _ => {
                sites[0].calls[0].target = CheckedDecisionCallTarget::DeriveFn(
                    canlang_compiler::analysis::resolve::SymbolId(u32::MAX),
                )
            }
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[owner.id.0 as usize],
                &db,
                cat.as_ref()
            )
            .is_none(),
            "corruption {corruption}"
        );
    }
    let mut changed = lowered.clone();
    let ir::IrItemKind::Scenario { guards, .. } = &mut changed.items[owner.id.0 as usize].kind
    else {
        panic!()
    };
    let ir::IrStmt::Require { cond, .. } = &mut guards[0] else {
        panic!()
    };
    cond.ty =
        canlang_compiler::analysis::ResolvedType::Scalar(canlang_compiler::analysis::Scalar::Int);
    assert!(
        collect_decision_sources(
            &program,
            &changed,
            &changed.items[owner.id.0 as usize],
            &db,
            cat.as_ref()
        )
        .is_none()
    );
}

#[test]
fn create_before_membership_and_guarded_send_preserves_sources_and_refuses_create_edits() {
    use canlang_compiler::codegen::{
        ir::{self, IrExpr, IrItemKind, IrStmt},
        scenario_decisions::{collect_decision_sources, serialize_decision_sources},
    };
    let source = "app CreateDecision\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\n Entry {person:user,label:text}\n Other {person:user,label:text}\n derive member(person:user?):bool=person!=null and active_member(person,team)\n policy Entry read=members\n policy Other read=members\nWhen\n crud Entry by=members fields=person,label when=true\n scenario run(person:user) by=members\n  require member(person)\n  do\n   create Entry {person,label=\"retained\"} as entry\n   if member(entry.person)\n    send LLM.cancel {revision=1,source=entry.label} when=member(entry.person) as stop\nThen\n";
    let (db, initial, diagnostics) = check(&[("create-decision.can", source)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(initial.checked_files()[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, initial.checked_files(), catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "CreateDecision.run")
        .unwrap()
        .id;
    let sites = collect_decision_sources(
        &program,
        &lowered,
        &lowered.items[owner.0 as usize],
        &db,
        catalog.as_ref(),
    )
    .unwrap();
    assert_eq!(
        sites.iter().map(|site| site.stage).collect::<Vec<_>>(),
        vec![
            CheckedDecisionStage::LeadingRequire,
            CheckedDecisionStage::BodyCondition,
            CheckedDecisionStage::SendDispatch,
        ]
    );
    assert_eq!(sites[1].position, vec![CheckedDecisionPosition::Body(1)]);
    assert_eq!(
        sites[2].position,
        vec![
            CheckedDecisionPosition::Body(1),
            CheckedDecisionPosition::Then(0)
        ]
    );
    for site in &sites {
        assert_eq!(site.calls.len(), 2);
        assert!(
            matches!(&site.calls[1].target, CheckedDecisionCallTarget::Builtin { id, .. } if id == "active_member")
        );
        assert_eq!(site.calls[1].chain.len(), 1);
        assert_eq!(site.source.path, "create-decision.can");
        assert_eq!(
            site.source.sha256,
            canlang_compiler::source::sha256_hex(source.as_bytes())
        );
    }
    let serialized = serialize_decision_sources(
        &program,
        &lowered,
        &lowered.items[owner.0 as usize],
        &db,
        catalog.as_ref(),
    )
    .unwrap();
    assert_eq!(serialized[2].stage, "send-dispatch");
    let IrItemKind::Scenario { effects, .. } = &lowered.items[owner.0 as usize].kind else {
        panic!()
    };
    let IrStmt::Create {
        model,
        when,
        binding,
        ..
    } = &effects[0]
    else {
        panic!()
    };
    assert_eq!(model, "CreateDecision.Entry");
    assert!(when.is_some());
    assert_eq!(binding.as_deref(), Some("entry"));
    for mutation in 0..12 {
        let mut changed = lowered.clone();
        let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
            panic!()
        };
        if mutation == 10 {
            effects.swap(0, 1);
        } else if mutation == 11 {
            let IrStmt::If { then_branch, .. } = &mut effects[1] else {
                panic!()
            };
            let IrStmt::Send { args, .. } = &mut then_branch[0] else {
                panic!()
            };
            let IrExpr::Object(fields) = &mut args.expr else {
                panic!()
            };
            fields[0].1.expr = IrExpr::Int(2);
        } else {
            let IrStmt::Create {
                model,
                input,
                when,
                binding,
                span,
            } = &mut effects[0]
            else {
                panic!()
            };
            match mutation {
                0 => *model = "CreateDecision.Other".into(),
                1 => {
                    let IrExpr::Object(fields) = &mut input.expr else {
                        panic!()
                    };
                    fields[1].0 = "edited".into();
                }
                2 => {
                    let IrExpr::Object(fields) = &mut input.expr else {
                        panic!()
                    };
                    fields[1].1.expr = IrExpr::Text("edited".into());
                }
                3 => {
                    input.ty = canlang_compiler::analysis::ResolvedType::Scalar(
                        canlang_compiler::analysis::Scalar::Bool,
                    )
                }
                4 => input.span.start += 1,
                5 => *when = None,
                6 => *when = Some("Other.create.when".into()),
                7 => *binding = None,
                8 => *binding = Some("edited".into()),
                _ => span.start += 1,
            }
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                catalog.as_ref()
            )
            .is_none(),
            "create/owner mutation {mutation}"
        );
        assert!(
            serialize_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                catalog.as_ref()
            )
            .is_none(),
            "serialized create/owner mutation {mutation}"
        );
    }
}

#[test]
fn named_page_query_predicates_keep_original_transitive_sites_and_refuse_render_edits() {
    use canlang_compiler::codegen::{
        ir::{self, IrCallTarget, IrExpr, IrItemKind},
        scenario_decisions::serialize_read_predicate_sources,
    };
    let source = "app PredicateFacts\nGiven\n Conversation {account:user,active:bool=false}\n Run {author:user,conversation:Conversation?}\n derive can_use(person:user?,conversation:Conversation):bool=person!=null and active_member(person,team) and conversation.account==person and conversation.active\n derive can_view(person:user?,run:Run):bool=person!=null and active_member(person,team) and run.author==person and (run.conversation==null or can_use(person,run.conversation))\n derive other(person:user?,run:Run):bool=true\n policy Conversation read=members where=can_use(actor,row)\n policy Run read=members where=can_view(actor,row)\nWhen\nThen\n page /runs title=\"Runs\"\n  list Run as run where can_view(actor,run)\n   text run.author\n page /other title=\"Other\"\n  list Run as run where can_view(actor,run)\n   text run.author\n";
    let (db, initial, diagnostics) = check(&[("page-predicates.can", source)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(initial.checked_files()[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, initial.checked_files(), catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let sites =
        serialize_read_predicate_sources(&program, &lowered, &db, catalog.as_ref()).unwrap();
    assert_eq!(sites.len(), 2);
    for (site, page) in sites.iter().zip(&lowered.modules[0].pages) {
        assert_eq!(site.stage, "read-predicate");
        assert_eq!(site.owner, format!("{}.{}", page.owner, page.fn_name));
        assert!(site.position.is_empty());
        assert_eq!(site.source.path, "page-predicates.can");
        assert_eq!(
            site.source.sha256,
            canlang_compiler::source::sha256_hex(source.as_bytes())
        );
        assert_eq!(
            source[site.node.start as usize..site.node.end as usize].trim(),
            "can_view(actor,run)"
        );
        assert_eq!(
            source[site.statement.start as usize..site.statement.end as usize].trim(),
            "Run as run where can_view(actor,run)"
        );
        assert_eq!(site.calls.len(), 4);
    }
    assert!(sites[0].node.start < sites[1].node.start);
    assert_ne!(sites[0].owner, sites[1].owner);
    let json = serde_json::to_value(&sites).unwrap();
    assert_eq!(
        json[0]["calls"][0]["target"]["name"],
        "PredicateFacts.can_view"
    );
    assert_eq!(json[0]["calls"][0]["slots"], serde_json::json!([0, 1]));
    assert_eq!(json[0]["calls"][1]["target"]["id"], "active_member");
    assert_eq!(json[0]["calls"][1]["arguments"][0]["type"], "user");
    assert_eq!(json[0]["calls"][1]["arguments"][1]["type"], "Team");
    assert_eq!(
        json[0]["calls"][1]["chain"][0]["derive"],
        "PredicateFacts.can_view"
    );
    assert_eq!(json[0]["calls"][3]["chain"].as_array().unwrap().len(), 2);
    assert_eq!(
        json[0]["calls"][3]["chain"][1]["derive"],
        "PredicateFacts.can_use"
    );
    for mutation in 0..9 {
        let mut changed = lowered.clone();
        if mutation == 8 {
            let helper = changed
                .items
                .iter_mut()
                .find(|item| item.canonical == "PredicateFacts.can_use")
                .unwrap();
            let IrItemKind::DeriveFn {
                expr: Some(body), ..
            } = &mut helper.kind
            else {
                panic!()
            };
            body.expr = IrExpr::Bool(false);
        } else {
            let page = &mut changed.modules[0].pages[0];
            if mutation == 5 {
                page.fn_name.push_str("Edited");
            } else if mutation == 6 {
                page.render[0].span.start += 1;
            } else if mutation == 7 {
                page.render[0].children[0].props[0].1.expr = IrExpr::Bool(false);
            } else if mutation == 3 {
                let (_, model) = page.render[0]
                    .props
                    .iter_mut()
                    .find(|(name, _)| name == "model")
                    .unwrap();
                model.expr = IrExpr::Text("PredicateFacts.Conversation".into());
            } else {
                let (_, predicate) = page.render[0]
                    .props
                    .iter_mut()
                    .find(|(name, _)| name == "where")
                    .unwrap();
                let IrExpr::Lambda { param, body } = &mut predicate.expr else {
                    panic!()
                };
                match mutation {
                    0 => body.expr = IrExpr::Bool(false),
                    1 => body.span.start += 1,
                    2 => *param = "other".into(),
                    _ => {
                        let IrExpr::Call { target, .. } = &mut body.expr else {
                            panic!()
                        };
                        *target = IrCallTarget::DeriveFn("PredicateFacts.other".into());
                    }
                }
            }
        }
        assert!(
            serialize_read_predicate_sources(&program, &changed, &db, catalog.as_ref()).is_none(),
            "page/query mutation {mutation}"
        );
    }
}

#[test]
fn semantic_ir_tampering_cannot_reuse_decision_proofs() {
    use canlang_compiler::codegen::{ir, scenario_decisions::collect_decision_sources};
    let source = "app SemanticDecision\nGiven\n derive good(a:int):bool = a>0\nWhen\n scenario run(a:int,b:int) by=members\n  do\n   let selected=a\n   if a>0\n    require good(selected) and true\nThen\n";
    let (db, initial, diagnostics) = check(&[("semantic.can", source)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (cat, ds) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(ds.is_empty());
    let (program, ds) = check_program(&db, initial.checked_files(), cat.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    let (original, ds) = ir::build(&program, &db, cat.as_ref());
    assert!(ds.is_empty());
    let id = original
        .items
        .iter()
        .find(|i| i.canonical == "SemanticDecision.run")
        .unwrap()
        .id;
    assert!(
        collect_decision_sources(
            &program,
            &original,
            &original.items[id.0 as usize],
            &db,
            cat.as_ref()
        )
        .is_some()
    );
    for mutation in 0..6 {
        let mut changed = original.clone();
        if mutation == 5 {
            let helper = changed
                .items
                .iter_mut()
                .find(|i| i.canonical == "SemanticDecision.good")
                .unwrap();
            let ir::IrItemKind::DeriveFn { expr: Some(e), .. } = &mut helper.kind else {
                panic!()
            };
            let ir::IrExpr::Binary { op, .. } = &mut e.expr else {
                panic!()
            };
            *op = ir::IrBinOp::Eq;
        } else {
            let ir::IrItemKind::Scenario { effects, .. } = &mut changed.items[id.0 as usize].kind
            else {
                panic!()
            };
            if mutation == 4 {
                let copy = effects[0].clone();
                effects.insert(0, copy);
            } else if mutation == 3 {
                let ir::IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!()
                };
                value.expr = ir::IrExpr::Name("b".into());
            } else {
                let ir::IrStmt::If {
                    cond, then_branch, ..
                } = &mut effects[1]
                else {
                    panic!()
                };
                if mutation == 2 {
                    let ir::IrExpr::Binary { op, .. } = &mut cond.expr else {
                        panic!()
                    };
                    *op = ir::IrBinOp::Eq;
                } else {
                    let ir::IrStmt::Require { cond, .. } = &mut then_branch[0] else {
                        panic!()
                    };
                    let ir::IrExpr::Binary { right, .. } = &mut cond.expr else {
                        panic!()
                    };
                    if mutation == 0 {
                        right.expr = ir::IrExpr::Bool(false);
                    } else {
                        then_branch.push(then_branch[0].clone());
                    }
                }
            }
        }
        if mutation == 1 {
            use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
            let facts = match changed.scenario_disclosures.get_mut(&id).unwrap() {
                ScenarioDisclosure::Complete(v) => v.source_facts.as_mut().unwrap(),
                ScenarioDisclosure::Declined(v) => v.source_facts.as_mut().unwrap(),
            };
            let sites = facts.decision_sites.as_mut().unwrap();
            let mut duplicate = sites[0].clone();
            duplicate.position = vec![
                CheckedDecisionPosition::Body(1),
                CheckedDecisionPosition::Then(1),
            ];
            sites.push(duplicate);
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[id.0 as usize],
                &db,
                cat.as_ref()
            )
            .is_none(),
            "semantic mutation {mutation}"
        );
    }
}

#[test]
fn serial_v1_preserves_actual_sources_types_slots_defaults_and_frames() {
    use canlang_compiler::codegen::{ir, scenario_decisions::serialize_decision_sources};
    let source = "app DecisionSerial\nuse helpers {good}\nGiven\nWhen\n scenario run(person:user,a:int,b:int) by=members\n  require good(last=b,first=a)\n  do\n   require active_member(person,team)\n   if a>0\n    require (good(first=a))\nThen\n";
    let helper = "package helpers\n Given\n  export derive good(first:int,last:int=abs(-2)):bool = first>0 and last>0\n When\n Then\n";
    let (db, initial, diagnostics) = check(&[("serial.can", source), ("helpers.can", helper)]);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (cat, ds) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(db.iter().next().unwrap().0, 0, 0),
    });
    assert!(ds.is_empty());
    let (program, ds) = check_program(&db, initial.checked_files(), cat.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    let (lowered, ds) = ir::build(&program, &db, cat.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    let id = lowered
        .items
        .iter()
        .find(|item| item.canonical == "DecisionSerial.run")
        .unwrap()
        .id;
    let json = serde_json::to_value(
        serialize_decision_sources(
            &program,
            &lowered,
            &lowered.items[id.0 as usize],
            &db,
            cat.as_ref(),
        )
        .unwrap(),
    )
    .unwrap();
    // Consume this exact compiler serialization through the installed State checker.
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("decision-sites.json");
    std::fs::write(&input, serde_json::to_vec(&json).unwrap()).unwrap();
    let runner = scratch.path().join("check-membership.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve(process.argv[2],'package.json'));
const state=dirname(require.resolve('@canlang/state'));
const {checkScenarioReceiptMembershipSites}=await import(pathToFileURL(resolve(state,'invocation/scenario-membership-plan.js')));
const produced=JSON.parse(readFileSync(process.argv[3],'utf8'));
const checked=checkScenarioReceiptMembershipSites(produced);
assert.deepEqual(checked,produced,'installed State preserves genuine compiler sources, stages, slots, defaults and frames');
assert.ok(Object.isFrozen(checked));
assert.equal(checked[1].calls[0].arguments[0].type,'user');
assert.equal(checked[1].calls[0].arguments[1].type,'Team');
assert.equal(checked[2].stage,'body-condition');
assert.equal(checked[3].calls[0].defaults[0].parameter,'helpers.good.last');
assert.equal(checked[3].calls[1].chain[0].derive,'helpers.good');
const lower=structuredClone(produced);
lower[1].calls[0].arguments[1].type='team';
assert.throws(()=>checkScenarioReceiptMembershipSites(lower),error=>error.code==='validation');
console.log('actual compiler v1 decision sites accepted by installed State; lowercase Team refused');
"#).unwrap();
    let consumed = std::process::Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        consumed.status.success(),
        "installed State decision consumer: {}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
    assert_eq!(json.as_array().unwrap().len(), 4);
    assert_eq!(json[0]["version"], 1);
    assert_eq!(json[0]["owner"], "DecisionSerial.run");
    assert_eq!(
        json[0]["source"],
        serde_json::json!({"path":"serial.can","sha256":canlang_compiler::source::sha256_hex(source.as_bytes()),"module":"DecisionSerial"})
    );
    assert_eq!(json[0]["stage"], "leading-require");
    assert_eq!(
        json[0]["position"],
        serde_json::json!([{ "kind":"guard","index":0 }])
    );
    assert_eq!(
        json[0]["calls"][0]["target"],
        serde_json::json!({"kind":"derive","name":"helpers.good"})
    );
    assert_eq!(json[0]["calls"][0]["slots"], serde_json::json!([1, 0]));
    let args = json[0]["calls"][0]["arguments"].as_array().unwrap();
    for (arg, expected) in args.iter().zip(["b", "a"]) {
        assert_eq!(arg["type"], "int");
        let start = arg["node"]["start"].as_u64().unwrap() as usize;
        let end = arg["node"]["end"].as_u64().unwrap() as usize;
        assert_eq!(&source[start..end], expected);
    }
    assert_eq!(json[1]["calls"][0]["arguments"][0]["type"], "user");
    assert_eq!(json[1]["calls"][0]["arguments"][1]["type"], "Team");
    assert_eq!(
        json[3]["position"],
        serde_json::json!([{ "kind":"body","index":1 },{"kind":"then","index":0}])
    );
    assert_eq!(json[2]["stage"], "body-condition");
    assert_eq!(json[3]["calls"][0]["slots"], serde_json::json!([0, null]));
    assert_eq!(
        json[3]["calls"][0]["defaults"][0]["parameter"],
        "helpers.good.last"
    );
    assert_eq!(
        json[3]["calls"][0]["defaults"][0]["source"],
        serde_json::json!({"path":"helpers.can","sha256":canlang_compiler::source::sha256_hex(helper.as_bytes()),"module":"helpers"})
    );
    assert_eq!(json[3]["calls"][0]["defaults"][0]["type"], "int");
    assert_eq!(json[3]["calls"][1]["chain"][0]["derive"], "helpers.good");
    for corruption in 0..4 {
        let mut changed = lowered.clone();
        let facts = match changed.scenario_disclosures.get_mut(&id).unwrap() {
            canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure::Complete(v) => {
                v.source_facts.as_mut().unwrap()
            }
            canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure::Declined(v) => {
                v.source_facts.as_mut().unwrap()
            }
        };
        let sites = facts.decision_sites.as_mut().unwrap();
        match corruption {
            0 => sites[0].owner = canlang_compiler::analysis::resolve::SymbolId(u32::MAX),
            1 => sites[0].source.sha256 = "0".repeat(64),
            2 => sites[3].calls[0].defaults.clear(),
            _ => {
                sites[0].calls[0].arguments[0].1 = canlang_compiler::analysis::ResolvedType::Unknown
            }
        }
        assert!(
            serialize_decision_sources(
                &program,
                &changed,
                &changed.items[id.0 as usize],
                &db,
                cat.as_ref()
            )
            .is_none(),
            "serial corruption {corruption}"
        );
    }
    let (role_db, role_program, ds) = check(&[(
        "role.can",
        "app RoleSerial\nGiven\n role reviewer label=\"Reviewer\"\nWhen\n scenario run(person:user) by=members\n  do require reviewer(person)\nThen\n",
    )]);
    assert!(ds.is_empty(), "{ds:?}");
    let (role_program, ds) = check_program(&role_db, role_program.checked_files(), cat.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    let (role_ir, ds) = ir::build(&role_program, &role_db, cat.as_ref());
    assert!(ds.is_empty());
    let role = role_ir
        .items
        .iter()
        .find(|i| i.canonical == "RoleSerial.run")
        .unwrap();
    assert!(
        serialize_decision_sources(&role_program, &role_ir, role, &role_db, cat.as_ref()).is_none()
    );

    // A literal default creates no nested call-origin check. Its transport
    // must still join the owning checked module, rather than trust IR labels.
    let literal_helper = helper.replace("abs(-2)", "2");
    let (literal_db, initial, ds) =
        check(&[("serial.can", source), ("helpers.can", &literal_helper)]);
    assert!(ds.is_empty(), "{ds:?}");
    let (literal_program, ds) = check_program(&literal_db, initial.checked_files(), cat.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    let (literal_ir, ds) = ir::build(&literal_program, &literal_db, cat.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    let literal_owner = literal_ir
        .items
        .iter()
        .find(|item| item.canonical == "DecisionSerial.run")
        .unwrap();
    assert!(
        serialize_decision_sources(
            &literal_program,
            &literal_ir,
            literal_owner,
            &literal_db,
            cat.as_ref()
        )
        .is_some()
    );
    let helper_module = literal_ir
        .modules
        .iter()
        .position(|module| module.name == "helpers")
        .unwrap();
    for corruption in 0..3 {
        let mut changed = literal_ir.clone();
        match corruption {
            0 => changed.modules[helper_module].name = "foreign".into(),
            1 => changed.modules[helper_module].file = literal_owner.span.file,
            _ => changed.modules[helper_module].span.start += 1,
        }
        assert!(
            serialize_decision_sources(
                &literal_program,
                &changed,
                &changed.items[literal_owner.id.0 as usize],
                &literal_db,
                cat.as_ref()
            )
            .is_none(),
            "literal default module corruption {corruption}"
        );
    }
}
