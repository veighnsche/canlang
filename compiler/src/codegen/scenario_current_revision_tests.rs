use super::*;
use crate::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use crate::analysis::{CheckedProgram, check_program};
use std::path::Path;

fn checked(sources: &[(&str, &str)]) -> (SourceDb, CheckedProgram, IrProgram, Option<Catalog>) {
    let mut db = SourceDb::new();
    let files = sources
        .iter()
        .map(|(name, text)| db.add((*name).into(), (*text).into()))
        .collect::<Vec<_>>();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &files, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = super::super::ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

#[test]
fn original_current_getters_and_same_let_data_are_borrowed_without_promotion() {
    let (db, program, ir, _) = checked(&[(
        "current-revision.can",
        include_str!("../../tests/fixtures/source-current-revision.can"),
    )]);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "SourceCurrentRevision.generate")
        .unwrap();
    let sites =
        checked_current_revision(&ir, owner, &db).expect("original nullable getter correspondence");
    assert_eq!(sites.parameter.name, "template");
    assert!(sites.presence_read.value.span.start < sites.published_read.value.span.start);
    let IrStmt::Let { value, .. } = sites.revision_statement else {
        panic!("original Let")
    };
    assert!(std::ptr::eq(value, sites.revision_read.value));
    assert_eq!(sites.template.canonical, "SourceCurrentRevision.Template");
    assert_eq!(sites.revision.canonical, "SourceCurrentRevision.Revision");
    let reads = [
        sites
            .active
            .as_ref()
            .expect("original leading active guard")
            .dependency,
        sites.presence_read.control,
        sites.published_read.control,
        sites.published.dependency,
        sites.revision_read.control,
        sites.revision_read.data.unwrap(),
        sites.digest_control.dependency,
        sites.digest_data.dependency,
        sites.outputs.dependency,
        sites.duration.dependency,
    ];
    assert_eq!(
        reads
            .iter()
            .map(|read| &read.id)
            .collect::<HashSet<_>>()
            .len(),
        10
    );
    assert_eq!(
        reads.iter().map(|read| read.role).collect::<Vec<_>>(),
        [
            DependencyRole::Control,
            DependencyRole::Control,
            DependencyRole::Control,
            DependencyRole::Control,
            DependencyRole::Control,
            DependencyRole::Data,
            DependencyRole::Control,
            DependencyRole::Data,
            DependencyRole::Data,
            DependencyRole::Data,
        ]
    );
    assert_eq!(
        sites.revision_read.control.node,
        sites.revision_read.data.unwrap().node
    );
    assert!(sites.presence.span.end < sites.published.value.span.end);
    assert!(sites.digest_presence.span.end <= sites.digest_data.value.span.start);
    assert_eq!(
        program.scenario_disclosures()[&owner.id]
            .source_facts()
            .unwrap()
            .source,
        ir.scenario_disclosures[&owner.id]
            .source_facts()
            .unwrap()
            .source
    );
    let copy = owner.clone();
    assert!(checked_current_revision(&ir, &copy, &db).is_none());
    for mode in [
        "nullable",
        "workflow",
        "server",
        "let",
        "data-role",
        "source",
        "loss",
        "active-loss",
        "active-role",
    ] {
        let mut changed = ir.clone();
        if mode == "let" {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.id.0 as usize].kind
            else {
                panic!("scenario")
            };
            let IrStmt::Let { name, .. } = &mut effects[0] else {
                panic!("original once Let")
            };
            *name = "copied".into();
        } else if matches!(mode, "nullable" | "workflow" | "server") {
            let name = if mode == "workflow" {
                "SourceCurrentRevision.Revision.definition"
            } else {
                "SourceCurrentRevision.Template.current"
            };
            let field = changed
                .items
                .iter_mut()
                .find(|item| item.canonical == name)
                .unwrap();
            let IrItemKind::Field { ty, server, .. } = &mut field.kind else {
                panic!("field")
            };
            if mode == "server" {
                *server = Some(IrServer::Actor);
            } else {
                *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
            }
        } else {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner.id).unwrap()
            else {
                panic!("proof")
            };
            if mode == "loss" {
                proof.source_facts = None;
            } else if mode == "source" {
                proof.source.sha256 = "0".repeat(64);
            } else if mode.starts_with("active-") {
                for row in &mut proof.returns {
                    if mode == "active-loss" {
                        row.dependencies.retain(|read| read.field_name != "active");
                    } else if let Some(read) = row
                        .dependencies
                        .iter_mut()
                        .find(|read| read.field_name == "active")
                    {
                        read.role = DependencyRole::Data;
                    }
                }
            } else {
                for row in &mut proof.returns {
                    row.dependencies
                        .iter_mut()
                        .find(|read| read.id == sites.revision_read.data.unwrap().id)
                        .unwrap()
                        .role = DependencyRole::Control;
                }
            }
        }
        assert!(
            checked_current_revision(&changed, &changed.items[owner.id.0 as usize], &db).is_none(),
            "{mode}"
        );
    }
}

#[test]
fn equivalent_current_revision_declarations_use_bound_models_formals_and_lets() {
    let source = include_str!("../../tests/fixtures/source-current-revision.can")
        .replace("SourceCurrentRevision", "DeclarationBound")
        .replace("Template", "Blueprint")
        .replace("Revision", "Edition")
        .replace("template", "blueprint")
        .replace("revision", "edition")
        .replace("validation", "stamp")
        .replace("WorkflowDefinition", "Workflow")
        .replace(
            "use std {Workflow}",
            "use std {WorkflowDefinition as Workflow}",
        );
    let (db, _, ir, _) = checked(&[("declaration-bound.can", &source)]);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "DeclarationBound.generate")
        .unwrap();
    let sites =
        checked_current_revision(&ir, owner, &db).expect("equivalent checked declaration lineage");
    assert_eq!(sites.parameter.name, "blueprint");
    assert_eq!(sites.template.canonical, "DeclarationBound.Blueprint");
    assert_eq!(sites.revision.canonical, "DeclarationBound.Edition");
    assert!(matches!(sites.revision_statement, IrStmt::Let {name, ..} if name == "edition"));
    assert_eq!(
        sites.presence_read.control.field,
        sites.revision_read.control.field
    );
    assert_eq!(
        sites.digest_control.dependency.field,
        sites.digest_data.dependency.field
    );
    assert!(sites.presence.span.end < sites.published.value.span.end);
    assert!(sites.digest_presence.span.end <= sites.digest_data.value.span.start);
    // Renaming authored declarations is different from mutating only their IR.
    for mode in ["target", "order", "copied-binding"] {
        let mut changed = ir.clone();
        if mode == "target" {
            let field = changed
                .items
                .iter_mut()
                .find(|item| item.id == sites.presence_read.control.field)
                .unwrap();
            let IrItemKind::Field { ty, .. } = &mut field.kind else {
                panic!("field")
            };
            *ty = IrType::Known(ResolvedType::Nullable(Box::new(ResolvedType::Record {
                symbol: sites.template.id,
                stored: true,
            })));
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.id.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "order" {
                effects.swap(0, 1);
            } else {
                let IrStmt::Let { name, .. } = &mut effects[0] else {
                    panic!("captured Let")
                };
                *name = "copied".into();
            }
        }
        assert!(
            checked_current_revision(&changed, &changed.items[owner.id.0 as usize], &db).is_none(),
            "{mode}"
        );
    }
}

#[test]
fn full_original_creative_inventory_cannot_supply_complete_current_reads() {
    let (db, program, ir, _) = checked(&[
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
        .find(|item| item.canonical == "creative.generate")
        .unwrap();
    let ScenarioDisclosure::Declined(declined) = &program.scenario_disclosures()[&owner.id] else {
        panic!("current source inventory is not a Complete native closure")
    };
    let source = declined
        .source_facts
        .as_deref()
        .expect("unchanged original source inventory");
    let current: Vec<_> = source
        .expression_types
        .as_deref()
        .unwrap()
        .iter()
        .filter(|(node, _)| {
            node.kind == SyntaxKind::Member as u8
                && db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
                    == "template.current"
        })
        .collect();
    assert_eq!(
        current.len(),
        3,
        "original presence, published receiver and once Let"
    );
    assert!(matches!(current[0].1, ResolvedType::Nullable(_)));
    assert_eq!(current[1].1, current[2].1);
    assert!(
        checked_current_revision(&ir, owner, &db).is_none(),
        "source inventory cannot fabricate the nine Complete Return reads"
    );
}

#[test]
fn original_current_revision_emits_three_getters_and_promotes_at_actual_leaves() {
    let (db, program, ir, catalog) = checked(&[(
        "current-revision.can",
        include_str!("../../tests/fixtures/source-current-revision.can"),
    )]);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "SourceCurrentRevision.generate")
        .unwrap();
    let sites = checked_current_revision(&ir, owner, &db).unwrap();
    let prepared =
        super::super::scenario_feasibility::prepare(&program, &ir, &db, catalog.as_ref()).unwrap();
    let selected = prepared.returns(&ir, owner.id).unwrap();
    assert_eq!(selected.len(), 1);
    let models = super::super::js::Emitter::source_models(&ir, &db).unwrap();
    let recipe = super::super::scenario_receipts::collect_native_scenario_receipt_with_feasibility(
        &ir,
        owner,
        &models,
        "SourceCurrentRevision.js",
        None,
        super::super::scenario_receipts::NativeReceiptSources {
            source_context: None,
            db: Some(&db),
            send_guards: None,
            query_plan: None,
        },
        Some(&prepared),
    )
    .expect("the original narrowed reads own the complete native receipt");
    assert_eq!(recipe.plan.returns.len(), 1);
    assert_eq!(recipe.plan.returns[0].id, selected[0].id);
    let original = selected[0];
    assert_eq!(original.dependencies.len(), 10);
    assert_eq!(
        recipe.plan.returns[0].dependencies.len(),
        original.dependencies.len()
    );
    for (actual, expected) in recipe.plan.returns[0]
        .dependencies
        .iter()
        .zip(&original.dependencies)
    {
        assert_eq!(actual.id, expected.id);
        assert_eq!(actual.model, expected.model_name);
        assert_eq!(actual.field, expected.field_name);
        assert_eq!(actual.type_id, expected.type_id);
        assert_eq!(
            actual.role,
            match expected.role {
                DependencyRole::Control => super::super::scenario_receipts::ReceiptRole::Control,
                DependencyRole::Data => super::super::scenario_receipts::ReceiptRole::Data,
            }
        );
    }
    assert_eq!(
        original
            .dependencies
            .iter()
            .map(|read| (read.field_name.as_str(), read.role))
            .collect::<Vec<_>>(),
        [
            ("active", DependencyRole::Control),
            ("current", DependencyRole::Control),
            ("current", DependencyRole::Control),
            ("published", DependencyRole::Control),
            ("current", DependencyRole::Control),
            ("current", DependencyRole::Data),
            ("digest", DependencyRole::Control),
            ("digest", DependencyRole::Data),
            ("outputs", DependencyRole::Data),
            ("duration", DependencyRole::Data),
        ]
    );
    let queries = std::collections::BTreeMap::new();
    let receipts = std::collections::BTreeMap::new();
    let output = super::super::js::emit_program_with_feasible_query_sources(
        &ir,
        true,
        &db,
        &queries,
        &receipts,
        Default::default(),
        Some(&prepared),
    );
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let js = &output.entry.js;
    assert_eq!(
        js.matches("readScenarioReceiptNullableStoredReference(c,")
            .count(),
        2
    );
    assert_eq!(js.matches("$receiptCurrentSource[\"current\"]").count(), 1);
    assert!(js.contains("let $receiptCurrentView;let $receiptCurrentData=false;"));
    let promotion = js
        .find("if($receiptCurrentView===undefined){$receiptCurrentView=await")
        .unwrap();
    let retained_data = js.find("if(!$receiptCurrentData){await").unwrap();
    assert!(promotion < retained_data);
    assert!(js[promotion..retained_data].contains(&sites.digest_control.dependency.id));
    assert!(js[retained_data..].contains(&sites.revision_read.data.unwrap().id));
    assert!(
        super::super::scenario_receipts::collect_native_scenario_receipt(
            &ir,
            owner,
            &models,
            "SourceCurrentRevision.js",
            None,
            super::super::scenario_receipts::NativeReceiptSources {
                source_context: None,
                db: Some(&db),
                send_guards: None,
                query_plan: None
            },
        )
        .is_none(),
        "raw emission cannot replace the original borrowed native subset"
    );
}

#[test]
fn original_current_factory_keeps_lazy_owner_policy_and_parent_selector_order() {
    let source = include_str!("../../tests/fixtures/source-current-revision.can");
    let (db, program, _, catalog) = checked(&[("current-revision.can", source)]);
    let mut result = crate::diagnostic::DiagnosticResult::new("current-revision", "1.0", 1);
    result.add_sources(&db);
    let (artifact, diagnostics) = crate::codegen::emit(
        &program,
        &crate::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: crate::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(artifact.model_policies.as_ref().unwrap().len(), 2);
    let scratch = tempfile::tempdir().unwrap();
    let source_path = scratch.path().join("current-revision.can");
    std::fs::write(&source_path, source).unwrap();
    std::fs::write(
        scratch.path().join("artifact.json"),
        crate::codegen::artifact::to_json(&artifact),
    )
    .unwrap();
    let runner = scratch.path().join("current-policy.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:process.argv[3]},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
assert.equal(loadArtifactDescriptors(artifact,{by:{role:'members'}}).modelPolicies.length,2);
const bindings=module.canApp().modelPolicyBindings;
const evaluate=bindings.find(binding=>binding.id==='SourceCurrentRevision.Template.require.1').evaluate;
const revision=bindings.find(binding=>binding.id==='SourceCurrentRevision.Revision.require.1').evaluate;
const select=bindings.find(binding=>binding.kind==='dependency').select;
const raw=Object.freeze({kind:'ref',model:'SourceCurrentRevision.Revision',id:'r'});
function input(duration,current,parent='t') {
 const events=[];const row={kind:'ref',model:'SourceCurrentRevision.Template',id:'t',duration};
 Object.defineProperty(row,'current',{get(){events.push('current');return current;}});
 const target={get parent(){events.push('parent');return {kind:'ref',model:row.model,id:parent};},get published(){events.push('published');return true;}};
 return {row,events,read:async reference=>{assert.equal(reference,raw);events.push('navigate');return target;}};
}
let value=input(0n,raw);assert.equal(await evaluate({},value.row,value.read),false);assert.deepEqual(value.events,[]);
value=input(120000n,null);assert.equal(await evaluate({},value.row,value.read),true);assert.deepEqual(value.events,['current']);
value=input(120000n,raw);assert.equal(await evaluate({},value.row,value.read),true);
assert.deepEqual(value.events,['current','current','navigate','parent','current','navigate','published']);
value=input(120000n,raw,'foreign');assert.equal(await evaluate({},value.row,value.read),false);
assert.deepEqual(value.events,['current','current','navigate','parent']);
value=input(120000n,raw);await assert.rejects(evaluate({},value.row,async()=>{throw new Error('missing-current');}),/missing-current/);
assert.deepEqual(value.events,['current','current']);
assert.equal(await revision({},{duration:120000n,published:false,digest:null}),true);
assert.equal(await revision({},{duration:120000n,published:true,digest:null}),false);
assert.equal(await revision({},{duration:120000n,published:true,digest:'verified'}),true);
const parent={model:'SourceCurrentRevision.Template',id:'t'},row={id:'r',parent};
const change={model:'SourceCurrentRevision.Revision',id:'r',before:null,after:row};
assert.deepEqual(await select({},change),[{model:parent.model,id:parent.id}]);
assert.deepEqual(await select({},{...change,before:row,after:null}),[{model:parent.model,id:parent.id}]);
assert.throws(()=>select({},{...change,model:'Foreign.Revision'}));
assert.throws(()=>select({},{...change,before:row,after:{...row,parent:{...parent,id:'other'}}}));
// This executes real emitted callbacks and declaration loading; no native owner row or grant is issued here.
"#).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let executed = std::process::Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(source_path)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
