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
    assert_eq!(sites.len(), 4);
    assert_eq!(
        sites.iter().map(|site| site.stage).collect::<Vec<_>>(),
        vec![
            CheckedDecisionStage::LeadingRequire,
            CheckedDecisionStage::BodyRequire,
            CheckedDecisionStage::BodyRequire,
            CheckedDecisionStage::SendDispatch
        ]
    );
    assert_eq!(sites[0].position, vec![CheckedDecisionPosition::Guard(0)]);
    assert_eq!(
        sites[2].position,
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
    let omitted = &sites[2].calls[0];
    assert_eq!(omitted.slots, vec![Some(0), None]);
    assert_eq!(omitted.defaults.len(), 1);
    assert_eq!(text(omitted.defaults[0].1), "abs(-2)");
    let default_call = &sites[2].calls[1];
    assert!(matches!(&default_call.target,CheckedDecisionCallTarget::Builtin{id,..} if id=="abs"));
    assert_eq!(default_call.source.path, "helpers.can");
    assert_eq!(default_call.chain.len(), 1);
    assert_eq!(default_call.chain[0].node, omitted.node);
    assert_eq!(default_call.chain[0].source.path, "decisions.can");
    assert!(sites[3].calls.iter().all(|call| call.defaults.is_empty()));
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
fn state_read_derive_and_dispatch_guards_retain_purity_refusal() {
    for source in [
        "app PureGate\nGiven\n derive member(person:user):bool = active_member(person,team)\nWhen\nThen\n",
        "app PureGate\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\nWhen\n scenario run(person:user) by=members\n  do send LLM.cancel {revision=1,source=\"fixed\"} when=active_member(person,team) as stop\nThen\n",
    ] {
        let (_, program, diagnostics) = check(&[("pure-gate.can", source)]);
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
        2
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
            8 => sites[1].calls[0].defaults.clear(),
            9 => sites[1].calls[1].chain.clear(),
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
