//! Fixed checked source and prepared observers versus altered retained IR.
//! This source mirrors recover's imported reference-array/helper guard and
//! first/create-or-reactivate tail; it does not qualify the original app.
use std::{collections::BTreeMap, path::Path};

use crate::analysis::{
    CheckedProgram, ResolvedType, Scalar,
    catalog::{Catalog, CatalogRequest, load_catalog},
    check_program,
    scenario_disclosure::{CheckedScenarioSource, ScenarioDisclosure},
};
use crate::source::{SourceDb, Span};

use super::{
    ir::{self, IrCallTarget, IrExpr, IrItemKind, IrProgram, IrStmt, IrType, TypedExpr},
    js::{self, EmitDecisionSources, JsOutput},
    read_predicates,
    scenario_decisions::FreshSourceContext,
    scenario_queries::{CollectedQueryPlan, PreparedQuerySources},
};

const SOURCE: &str = r#"app SourceRequireRetained uses=[directory]
package locations
 Given
  export Location {name:text}
  policy Location read=public fields=name
 When
 Then
package employee
 use locations {Location}
 Given
  export Employee {user:user,home:Location,locations:Location[],active:bool=true,operator_wide:bool=false}
  export derive can_work(person:user,location:Location):bool = any(Employee as e,e.user==person and e.active and active_member(person,team) and (e.operator_wide or e.home==location or location in e.locations))
  policy Employee read=members fields=user,home,locations,active,operator_wide
 When
 Then
package directory
 use locations {Location}
 use employee {can_work}
 Given
  role manager
  Customer {kind:enum(individual,company),locations:Location[]}
  CompanyRole in Customer {account:user,role:enum(administrator,booker),locations:Location[],active:bool=true}
  derive customer_staff(person:user,org:Customer):bool = any(org.locations as location,can_work(person,location))
  policy Customer read=manager and customer_staff(actor,row)
  policy CompanyRole read=manager and customer_staff(actor,row.parent)
  invariant CompanyRole: row.parent.kind==company
  unique CompanyRole fields=account,role
 When
  scenario recover(org:Customer,account:user,reason:text) by=manager
   require customer_staff(actor,org) and trim(reason)!="" and org.kind==company
   do
    let previous=first(org.CompanyRole as grant where grant.account==account and grant.role==administrator order=grant.id)
    if previous==null
     create CompanyRole {parent=org,account,role=administrator,locations=org.locations} as grant
    else
     set previous {active=true,locations=org.locations}
 Then
"#;

fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    fixture_source(SOURCE)
}

fn fixture_source(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("source-require-retained.can".into(), source.into());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

#[test]
fn body_require_seals_the_inlined_derived_member_body() {
    let source = "app DerivedGuard\nGiven\n P {value:int}\n C in P {n:int}\n derive P.total:int = sum(row.C as child select child.n)\n policy P read=members\n policy C read=members\nWhen\n scenario consume(p:P) by=members\n  do\n   require p.total>=0\nThen\n";
    let (db, program, mut ir, catalog) = fixture_source(source);
    let context = FreshSourceContext::prepare(&program, &ir, &db, Some(&catalog)).unwrap();
    let sources = super::scenario_decisions::serialize_scenario_requires(&context).unwrap();
    assert_eq!(sources.len(), 1, "original pre-write aggregate Require");
    let derived = index(&ir, "DerivedGuard.P.total");
    let IrItemKind::DeriveField {
        expr: Some(body), ..
    } = &mut ir.items[derived].kind
    else {
        panic!("derived aggregate");
    };
    body.expr = IrExpr::Int(0);
    let context = FreshSourceContext::prepare(&program, &ir, &db, Some(&catalog)).unwrap();
    assert!(
        super::scenario_decisions::serialize_scenario_requires(&context).is_none(),
        "retained Member spelling cannot authorize an altered executable body"
    );
}

fn index(ir: &IrProgram, name: &str) -> usize {
    ir.items
        .iter()
        .position(|item| item.canonical == name)
        .expect(name)
}
fn guard(ir: &mut IrProgram) -> &mut TypedExpr {
    let index = index(ir, "directory.recover");
    let IrItemKind::Scenario { guards, .. } = &mut ir.items[index].kind else {
        panic!("recover")
    };
    let IrStmt::Require { cond, .. } = &mut guards[0] else {
        panic!("original leading Require")
    };
    cond
}
fn facts(ir: &mut IrProgram) -> &mut CheckedScenarioSource {
    let owner = ir.items[index(ir, "directory.recover")].id;
    match ir.scenario_disclosures.get_mut(&owner).unwrap() {
        ScenarioDisclosure::Complete(value) => value.source_facts.as_deref_mut().unwrap(),
        _ => panic!("recover must have complete original disclosure"),
    }
}
fn customer_staff_arguments(expr: &mut TypedExpr) -> &mut Vec<TypedExpr> {
    match &mut expr.expr {
        IrExpr::Call {
            target: IrCallTarget::DeriveFn(name),
            args,
        }
        | IrExpr::BoundCall {
            target: IrCallTarget::DeriveFn(name),
            args,
            ..
        } if name == "directory.customer_staff" => args,
        IrExpr::Binary { left, .. } => customer_staff_arguments(left),
        _ => panic!("original first customer_staff call"),
    }
}

/// Prepare once from the unchanged source/program/IR; only then alter the
/// retained consumer copy. Query receipts and source observers stay fixed.
fn emit_after(change: impl FnOnce(&mut IrProgram)) -> (JsOutput, bool) {
    let (db, program, ir, catalog) = fixture();
    let context = FreshSourceContext::prepare(&program, &ir, &db, Some(&catalog)).unwrap();
    let observer =
        read_predicates::prepare_with_context(&context).expect("original observer preparation");
    assert_eq!(observer.source_requires(&ir).unwrap().len(), 1);
    let prepared_queries = PreparedQuerySources::from_context(&context);
    let mut queries = BTreeMap::new();
    let mut receipts = BTreeMap::new();
    let mut any = BTreeMap::new();
    let entry = js::pick_entrypoint(&ir).unwrap();
    let module = js::module_path(&ir.module(entry).name);
    for item in &ir.items {
        let collected = prepared_queries.collect_owner(item, &module);
        if let Some(metadata) = collected.any {
            any.insert(item.canonical.clone(), metadata);
        }
        match collected.plan {
            Some(CollectedQueryPlan::Receipt(receipt)) => {
                queries.insert(
                    item.canonical.clone(),
                    serde_json::to_value(&receipt.plan).unwrap(),
                );
                receipts.insert(item.canonical.clone(), *receipt);
            }
            Some(CollectedQueryPlan::Source(plan)) => {
                queries.insert(item.canonical.clone(), serde_json::to_value(plan).unwrap());
            }
            Some(CollectedQueryPlan::Transcript(_)) => panic!("no transcript in this fixture"),
            None => {}
        }
    }
    let membership =
        super::membership::prepare_with_context(&context).expect("original membership source");
    let policies = super::model_policies::collect_checked_policies(
        &program,
        &ir,
        &db,
        Some(&catalog),
        &module,
    );
    let origins = super::model_unique_conditions::collect_checked_model_rule_origins(
        &program,
        &ir,
        &db,
        Some(&catalog),
    );
    let uniques = super::model_unique_conditions::collect_checked_unique_conditions(
        &program,
        &ir,
        &db,
        Some(&catalog),
    );
    let mut retained = ir.clone();
    change(&mut retained);
    let observer_sealed = observer.source_requires(&retained).is_some();
    let output = js::emit_program_with_feasible_query_sources(
        &retained,
        true,
        &db,
        &queries,
        &receipts,
        EmitDecisionSources {
            read_predicates: Some(&observer),
            membership: Some(&membership),
            query_any: Some(&any),
            local_policies: policies.as_ref(),
            model_rule_origins: origins.as_deref(),
            unique_conditions: uniques.as_deref(),
            ..Default::default()
        },
        prepared_queries.returns(),
    );
    (output, observer_sealed)
}

#[test]
fn original_source_require_emits_its_private_observer_and_complete_recover() {
    let (output, sealed) = emit_after(|_| {});
    assert!(sealed);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let javascript = std::iter::once(&output.entry)
        .chain(&output.packages)
        .map(|module| module.js.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(javascript.contains("canScenarioRequireSource"));
    assert!(javascript.contains("await nativeScenarioRequire(c,"));
    assert!(
        output
            .operations
            .iter()
            .any(|operation| operation.name == "directory.recover")
    );
}

#[test]
fn prepared_source_require_refuses_retained_guard_helper_arguments_parameters_and_inventory_changes()
 {
    let mutations: &[(&str, fn(&mut IrProgram))] = &[
        ("guard body", |ir| guard(ir).expr = IrExpr::Bool(true)),
        ("nested imported helper", |ir| {
            let index = index(ir, "employee.can_work");
            let IrItemKind::DeriveFn {
                expr: Some(expr), ..
            } = &mut ir.items[index].kind
            else {
                panic!("can_work")
            };
            expr.expr = IrExpr::Bool(true);
        }),
        ("same-typed call argument", |ir| {
            customer_staff_arguments(guard(ir))[0].expr = IrExpr::Name("account".into())
        }),
        ("parameter declaration", |ir| {
            let owner = index(ir, "directory.recover");
            let IrItemKind::Scenario { params, .. } = &ir.items[owner].kind else {
                panic!("recover")
            };
            let parameter = params[2];
            let IrItemKind::Param { ty, .. } = &mut ir.items[parameter.0 as usize].kind else {
                panic!("reason")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Bool));
        }),
        ("dropped observer inventory", |ir| {
            facts(ir).source_requires = Some(Vec::new())
        }),
        ("altered observer call argument", |ir| {
            let site = &mut facts(ir).source_requires.as_mut().unwrap()[0];
            site.calls[0].arguments[0].0.start += 1;
        }),
    ];
    for (label, mutate) in mutations {
        let (output, sealed) = emit_after(mutate);
        assert!(
            !sealed,
            "{label}: original prepared observer cannot bind altered retained IR"
        );
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{label}: {:?}",
            output.diagnostics
        );
        assert!(
            !std::iter::once(&output.entry)
                .chain(&output.packages)
                .any(|module| module.js.contains("await nativeScenarioRequire(c,")),
            "{label}: no original guard authority from changed IR"
        );
    }
}

#[test]
fn source_require_pipeline_preserves_unrelated_ir_refusal_and_rejects_changed_consumers() {
    // Keep the imported declaration owners in separate files. The extra page
    // has an honest current backend refusal and grants nothing to recover.
    let mut db = SourceDb::new();
    let mut files = Vec::new();
    for (index, piece) in SOURCE.split("\npackage ").enumerate() {
        let source = if index == 0 {
            piece.to_owned()
        } else {
            format!("package {piece}")
        };
        files.push(db.add(format!("separate-owner-{index}.can"), source));
    }
    let unrelated = db.add("unrelated-archive.can".into(),
        "package archive_noise\n Given\n  Entry {name:text}\n  policy Entry read=public\n When\n Then\n  page /archive-noise title=\"Archive\"\n   list Entry archived=include as row\n    text row.name\n".into());
    files.push(unrelated);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
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
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.primary.file == unrelated
                && diagnostic.message.contains("query clause archived")),
        "{diagnostics:?}"
    );
    let context = FreshSourceContext::prepare_queries(&program, &ir, &db, Some(&catalog)).unwrap();
    assert!(context.has_ir_errors());
    let prepared = read_predicates::prepare_requires_with_context(&context)
        .expect("independently sealed source Require");
    assert_eq!(prepared.source_requires(&ir).unwrap().len(), 1);
    assert!(prepared.predicates(&ir).unwrap().is_empty());
    assert!(prepared.booleans(&ir).unwrap().is_empty());
    assert!(prepared.boolean_rules(&ir).unwrap().is_empty());
    assert_eq!(prepared.boolean_derives(&ir).unwrap().len(), 2);

    // Exercise the same public pipeline as the compile command; checking only
    // the private serializer would miss the full-IR context selection defect.
    let mut result = crate::diagnostic::DiagnosticResult::new(
        env!("CARGO_PKG_VERSION"),
        crate::LANGUAGE_VERSION,
        crate::SCHEMA_VERSION,
    );
    result.add_sources(&db);
    let (artifact, diagnostics) = super::emit(
        &program,
        &super::EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: super::EmitOptions {
                native_scenario_receipts: true,
                ..Default::default()
            },
        },
    );
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.primary.file == unrelated
                && diagnostic.message.contains("query clause archived")),
        "{diagnostics:?}"
    );
    assert!(
        !diagnostics
            .iter()
            .any(|diagnostic| diagnostic.primary.file != unrelated),
        "recover keeps its complete lowering: {diagnostics:?}"
    );
    assert!(
        artifact
            .modules
            .iter()
            .any(|module| module.js.contains("canScenarioRequireSource")
                && module.js.contains("await nativeScenarioRequire(c,"))
    );
    assert!(
        artifact
            .operations
            .iter()
            .any(|operation| operation.name == "directory.recover")
    );

    for change_helper in [false, true] {
        let mut retained = ir.clone();
        if change_helper {
            let helper = index(&retained, "employee.can_work");
            let IrItemKind::DeriveFn {
                expr: Some(body), ..
            } = &mut retained.items[helper].kind
            else {
                panic!("original helper")
            };
            body.expr = IrExpr::Bool(true);
        } else {
            guard(&mut retained).expr = IrExpr::Bool(true);
        }
        assert!(
            prepared.source_requires(&retained).is_none(),
            "whole retained-IR seal rejects a changed consumer"
        );
        let changed =
            FreshSourceContext::prepare_queries(&program, &retained, &db, Some(&catalog)).unwrap();
        assert!(
            read_predicates::prepare_requires_with_context(&changed).is_none(),
            "fresh source correspondence rejects changed guard/helper"
        );
    }
}
