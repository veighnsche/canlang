//! Source-owned SEQ-011 conditional unique association; no handbound runtime plan.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItemKind, IrModelRuleKind, IrProgram, IrType};
use canlang_compiler::codegen::model_unique_conditions::{
    collect_checked_model_rule_origins, collect_checked_unique_conditions,
};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, sha256_hex};
use std::{path::Path, process::Command};

// Byte-identical original source literal in model_rule_origins.rs18.
const SOURCE: &str = "package Office\n Given\n  Item {qty:int,title:text,closed:bool}\n  Bin {qty:int,title:text,closed:bool}\n  policy Item read=public\n  policy Bin read=public\n  invariant Bin: row.qty>=0\n  lock Item fields=title\n  invariant Item: row.qty>=0\n  unique Item fields=qty where=row.closed\n  lock Bin fields=title when=row.closed\n  invariant Item: row.qty<=100\n When\n Then\npackage Warehouse\n Given\n  Item {qty:int,title:text}\n  policy Item read=public\n  invariant Item: row.qty>=0\n  lock Item fields=title\n When\n Then\n";

fn checked(source: &str) -> (SourceDb, CheckedProgram, IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add("model-rules.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[file], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir)
}

#[test]
fn original_office_conditional_unique_keeps_declaration_registry_owner_and_boolean_equivalence() {
    assert!(
        include_str!("model_rule_origins.rs").contains(&format!("{SOURCE:?}")),
        "unchanged original literal"
    );
    let (db, program, ir) = checked(SOURCE);
    let facts = collect_checked_unique_conditions(&program, &ir, &db, None).unwrap();
    let [fact] = facts.as_slice() else {
        panic!("one actual source conditional unique");
    };
    assert_eq!(fact.canonical_model, "Office.Item");
    assert_eq!(fact.owner_package, "Office");
    assert_eq!(fact.module, program.symbols[fact.model.0 as usize].module);
    assert_eq!(fact.fields, ["qty"]);
    assert_eq!(fact.field_symbols.len(), 1);
    assert_eq!(
        program.symbols[fact.field_symbols[0].0 as usize].canonical,
        "Office.Item.qty"
    );
    assert_eq!(fact.registry_id, "Office.Item.unique.1");
    assert_eq!(fact.source.path, "model-rules.can");
    assert_eq!(fact.source.sha256, sha256_hex(SOURCE.as_bytes()));
    assert_eq!(fact.source.module, "Office");
    let declared = &program.effects.models[&fact.model].uniques[0];
    assert_eq!(fact.ordinal, declared.id);
    assert_eq!(fact.node, declared.node);
    assert_eq!(fact.where_node, declared.where_predicate.unwrap());
    assert_eq!(fact.fields_node, declared.fields_node.unwrap());
    assert_eq!(
        fact.predicate,
        serde_json::json!({"op":"eq","field":"closed","value":true})
    );
    let registry = ir
        .invariants
        .iter()
        .find(|rule| rule.id == fact.registry_id)
        .unwrap();
    assert!(
        registry.origin.is_none(),
        "conditional unique stays separate from invariants"
    );
    assert!(
        ir.invariants
            .iter()
            .filter_map(|rule| rule.origin.as_ref())
            .all(|origin| origin.kind == IrModelRuleKind::Invariant)
    );
    for actual in [false, true] {
        assert_eq!(
            fact.predicate["value"].as_bool().unwrap() == actual,
            actual,
            "same boolean acceptance as original row.closed"
        );
    }
    let office = ir
        .items
        .iter()
        .find(|item| item.canonical == "Office.Item")
        .unwrap();
    let IrItemKind::Model {
        uniques,
        invariants,
        ..
    } = &office.kind
    else {
        unreachable!()
    };
    assert_eq!(uniques[0].fields, fact.fields);
    assert!(!invariants.contains(&fact.registry_id));
    assert!(
        ir.items
            .iter()
            .any(|item| item.canonical == "Warehouse.Item")
    );
}

#[test]
fn primitive_conditions_preserve_boolean_operand_order_and_canonical_literal_wire() {
    let source = SOURCE.replace(
        "where=row.closed",
        "where=(row.closed==true and not (row.qty!=5 or row.title==\"reserved\"))",
    );
    let (db, program, ir) = checked(&source);
    let facts = collect_checked_unique_conditions(&program, &ir, &db, None).unwrap();
    assert_eq!(
        facts[0].predicate,
        serde_json::json!({"op":"and","args":[
            {"op":"eq","field":"closed","value":true},
            {"op":"not","arg":{"op":"or","args":[
                {"op":"ne","field":"qty","value":"5"},
                {"op":"eq","field":"title","value":"reserved"}
            ]}}
        ]})
    );
}

#[test]
fn stale_source_type_owner_registry_predicate_and_unique_field_mutations_refuse() {
    let (db, program, original) = checked(SOURCE);
    let office = original
        .items
        .iter()
        .find(|item| item.canonical == "Office.Item")
        .unwrap()
        .id;
    let warehouse = original
        .items
        .iter()
        .find(|item| item.canonical == "Warehouse.Item")
        .unwrap()
        .id;
    let closed = original
        .items
        .iter()
        .find(|item| item.canonical == "Office.Item.closed")
        .unwrap()
        .id;
    let registry = original
        .invariants
        .iter()
        .position(|rule| rule.id == "Office.Item.unique.1")
        .unwrap();
    for mutation in [
        "field",
        "field-owner",
        "field-type",
        "canonical",
        "registry-id",
        "registry-kind",
        "where-operand",
        "where-type",
        "where-source",
        "where-missing",
        "unique-span",
        "composite",
    ] {
        let mut ir = original.clone();
        match mutation {
            "field" => {
                let IrItemKind::Model { uniques, .. } = &mut ir.items[office.0 as usize].kind
                else {
                    unreachable!()
                };
                uniques[0].fields[0] = "title".into();
            }
            "field-owner" => {
                let IrItemKind::Field { owner, .. } = &mut ir.items[closed.0 as usize].kind else {
                    unreachable!()
                };
                *owner = warehouse;
            }
            "field-type" => {
                let IrItemKind::Field { ty, .. } = &mut ir.items[closed.0 as usize].kind else {
                    unreachable!()
                };
                *ty = IrType::Known(canlang_compiler::analysis::ResolvedType::Scalar(
                    canlang_compiler::analysis::Scalar::Text,
                ));
            }
            "canonical" => ir.items[closed.0 as usize].canonical = "Warehouse.Item.closed".into(),
            "registry-id" => ir.invariants[registry].id = "Warehouse.Item.unique.1".into(),
            "registry-kind" => {
                ir.invariants[registry].origin =
                    ir.invariants.iter().find_map(|rule| rule.origin.clone())
            }
            "where-operand" => {
                let IrExpr::Member { base, .. } = &mut ir.invariants[registry].pred.expr else {
                    unreachable!()
                };
                base.expr = IrExpr::Name("foreign".into());
            }
            "where-type" => {
                ir.invariants[registry].pred.ty = canlang_compiler::analysis::ResolvedType::Scalar(
                    canlang_compiler::analysis::Scalar::Text,
                )
            }
            "where-source" => ir.invariants[registry].span.start += 1,
            "where-missing" => {
                ir.invariants.remove(registry);
            }
            "unique-span" => {
                let IrItemKind::Model { uniques, .. } = &mut ir.items[office.0 as usize].kind
                else {
                    unreachable!()
                };
                uniques[0].span.start += 1;
            }
            "composite" => {
                let IrItemKind::Model { uniques, .. } = &mut ir.items[office.0 as usize].kind
                else {
                    unreachable!()
                };
                uniques[0].fields.push("title".into());
            }
            _ => unreachable!(),
        }
        assert!(
            collect_checked_unique_conditions(&program, &ir, &db, None).is_none(),
            "{mutation}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "model-rules.can".into(),
        SOURCE.replace("where=row.closed", "where=not row.closed"),
    );
    assert!(collect_checked_unique_conditions(&program, &original, &stale, None).is_none());
}

#[test]
fn unsupported_unique_conditions_stay_visible_without_unconditional_or_invariant_conversion() {
    for condition in ["row.qty>5", "row.closed==row.closed", "actor!=null"] {
        let source = SOURCE.replace("where=row.closed", &format!("where={condition}"));
        let (db, program, ir) = checked(&source);
        assert!(
            collect_checked_unique_conditions(&program, &ir, &db, None).is_none(),
            "{condition}"
        );
    }
    let source = SOURCE.replace(
        "fields=qty where=row.closed",
        "fields=qty,title where=row.closed",
    );
    let (db, program, ir) = checked(&source);
    assert!(
        collect_checked_unique_conditions(&program, &ir, &db, None).is_none(),
        "no composite field-map approximation"
    );
    let source = SOURCE.replace(
        "unique Item fields=qty where=row.closed",
        "unique Item fields=qty",
    );
    let (db, program, ir) = checked(&source);
    assert!(
        collect_checked_unique_conditions(&program, &ir, &db, None)
            .unwrap()
            .is_empty(),
        "ordinary unconditional declaration is unchanged"
    );
}

#[test]
fn original_conditional_unique_artifact_and_verified_factory_share_exact_existing_entry() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("model-rules.can");
    std::fs::write(&input, SOURCE).unwrap();
    let mut db = SourceDb::new();
    let file = db.add(input.to_str().unwrap().into(), SOURCE.into());
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: root,
        primary: canlang_compiler::source::Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let facts = collect_checked_unique_conditions(&program, &ir, &db, Some(&catalog)).unwrap();
    let [fact] = facts.as_slice() else {
        panic!("one exact original declaration");
    };
    let mut result = DiagnosticResult::new(env!("CARGO_PKG_VERSION"), "1.0", 1);
    result.add_sources(&db);
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let artifact: serde_json::Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    for name in ["Office.Item", "Warehouse.Item"] {
        let model = artifact["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["name"] == name)
            .unwrap();
        assert!(
            model.get("uniqueKeys").is_none(),
            "declaration does not invent a field-modifier unconditional key"
        );
    }
    let expected_census =
        collect_checked_model_rule_origins(&program, &ir, &db, Some(&catalog)).unwrap();
    assert_eq!(expected_census.len(), 11);
    let expected = serde_json::json!({
        "fields":fact.fields,"where":fact.registry_id,"wherePredicate":fact.predicate,"ordinal":fact.ordinal,
        "source":{"path":fact.source.path,"sha256":fact.source.sha256,"module":fact.source.module},
        "declaredAt":{"start":fact.node.start,"end":fact.node.end,
            "fields":{"start":fact.fields_node.start,"end":fact.fields_node.end},
            "where":{"start":fact.where_node.start,"end":fact.where_node.end}}
    });
    std::fs::write(
        scratch.path().join("artifact.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    std::fs::write(
        scratch.path().join("expected.json"),
        serde_json::to_vec(&expected).unwrap(),
    )
    .unwrap();
    std::fs::write(
        scratch.path().join("expected-census.json"),
        serde_json::to_vec(&expected_census).unwrap(),
    )
    .unwrap();
    let runner = scratch.path().join("conditional-unique.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=realpathSync(process.argv[2]);
const require=createRequire(resolve(root,'package.json'));
const own=specifier=>{const path=realpathSync(require.resolve(specifier));assert.ok(path.startsWith(root+'/'),specifier+' must use this compiler worktree output');return pathToFileURL(path);};
const {assembleModules,importVerifiedAssemblyModule}=await import(own('@canlang/cloudflare/runtime/modules'));
const {loadArtifactDescriptors}=await import(own('@canlang/state/invocation/registry'));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const expected=JSON.parse(readFileSync(resolve(base,'expected.json'),'utf8'));
const sourcePath=resolve(base,'model-rules.can');
const assembly=await assembleModules({artifact,sourcePath},{workDir:resolve(base,'modules'),stdlibUrl:own('@canlang/cloudflare/runtime/stdlib').href});
const loaded=loadArtifactDescriptors(artifact,{by:'public'});
for(const name of ['Office.Item','Warehouse.Item']){
 const model=loaded.models.find(model=>model.name===name);assert.ok(model);
 assert.ok(model.uniqueKeys===undefined||model.uniqueKeys.length===0,'source uniques do not become unconditional field modifiers');
}
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const definition=module.appDefinition,registry=module.canApp();
const expectedCensus=JSON.parse(readFileSync(resolve(base,'expected-census.json'),'utf8'));
assert.deepEqual(definition.modelRuleOrigins,expectedCensus);
assert.equal(definition.modelRuleOrigins.length,11);
assert.equal(artifact.modules.reduce((count,module)=>count+(module.js.match(/modelRuleOrigins:/g)||[]).length,0),1,'one complete census, not per-unique replicas');
assert.equal(definition.modelRuleOrigins[5].kind,'unique');assert.equal(definition.modelRuleOrigins[5].model,'Office.Item');
assert.equal(definition.modelRuleOrigins[5].registryId,'Office.Item.unique.1');

assert.ok(definition.models['Office.Item']);assert.ok(definition.models['Warehouse.Item']);
const declarations=definition.models['Office.Item'].uniques;
assert.equal(declarations.length,1);assert.deepEqual(declarations[0],expected);
assert.ok(!definition.models['Warehouse.Item'].uniques||definition.models['Warehouse.Item'].uniques.length===0);
assert.ok(!definition.models['Office.Item'].invariants.includes(expected.where),'unique remains separate from owning row invariants');
const callback=registry.invariants[expected.where];assert.equal(typeof callback,'function');
assert.notEqual(callback,registry.invariants['Warehouse.Item.require.1']);
// These plain scalar field inputs exercise the verified pure source callback.
// They have no model identity, native binding, call, store or row authority.
for(const closed of [false,true]){
 const scalarFields=Object.freeze({closed});
 const answer=await callback(undefined,scalarFields);
 assert.equal(typeof answer,'boolean');
 assert.equal(answer,closed===expected.wherePredicate.value);
}
"#).unwrap();
    let run = Command::new("node")
        .arg(runner)
        .arg(root)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
}

#[test]
fn original_global_model_rule_census_retains_every_interleaved_declaration_once() {
    let (db, program, ir) = checked(SOURCE);
    let census = collect_checked_model_rule_origins(&program, &ir, &db, None).unwrap();
    let expected = [
        ("policy", "Office.Item"),
        ("policy", "Office.Bin"),
        ("invariant", "Office.Bin"),
        ("lock", "Office.Item"),
        ("invariant", "Office.Item"),
        ("unique", "Office.Item"),
        ("lock", "Office.Bin"),
        ("invariant", "Office.Item"),
        ("policy", "Warehouse.Item"),
        ("invariant", "Warehouse.Item"),
        ("lock", "Warehouse.Item"),
    ];
    assert_eq!(census.len(), expected.len());
    for (index, (entry, (kind, model))) in census.iter().zip(expected).enumerate() {
        assert_eq!(entry["ordinal"], index);
        assert_eq!(entry["kind"], kind);
        assert_eq!(entry["model"], model);
        assert_eq!(entry["ownerPackage"], model.split('.').next().unwrap());
        assert_eq!(entry["source"]["path"], "model-rules.can");
        assert_eq!(entry["source"]["sha256"], sha256_hex(SOURCE.as_bytes()));
        let start = entry["declaredAt"]["start"].as_u64().unwrap() as usize;
        let end = entry["declaredAt"]["end"].as_u64().unwrap() as usize;
        assert!(SOURCE[start..end].trim().starts_with(kind));
    }
    assert_eq!(census[5]["registryId"], "Office.Item.unique.1");
    let unique = collect_checked_unique_conditions(&program, &ir, &db, None)
        .unwrap()
        .remove(0);
    assert_eq!(unique.ordinal, 5);
    assert_eq!(
        census[5]["declaredAt"],
        serde_json::json!({"start":unique.node.start,"end":unique.node.end})
    );
}

#[test]
fn incomplete_reordered_wrong_global_ordinal_owner_source_and_executable_censuses_refuse() {
    let (db, program, original) = checked(SOURCE);
    let office = original
        .items
        .iter()
        .find(|item| item.canonical == "Office.Item")
        .unwrap()
        .id;
    for mutation in ["missing", "reordered", "model", "source", "anchor"] {
        let mut ir = original.clone();
        match mutation {
            "missing" => {
                ir.read_rules.remove(0);
            }
            "reordered" => ir.invariants.swap(0, 1),
            "model" => ir.items[office.0 as usize].canonical = "Warehouse.Item".into(),
            "source" => ir.modules[0].file = canlang_compiler::source::SourceId(u32::MAX),
            "anchor" => ir.invariants[0].span.start += 1,
            _ => unreachable!(),
        }
        assert!(
            collect_checked_model_rule_origins(&program, &ir, &db, None).is_none(),
            "{mutation}"
        );
        assert!(
            collect_checked_unique_conditions(&program, &ir, &db, None).is_none(),
            "{mutation} unique intake"
        );
    }
    // Rebuild from edited public tables too: contiguity and lexical source
    // correspondence authenticate neither a duplicated nor swapped ordinal.
    for swapped in [false, true] {
        let (db, mut program, _) = checked(SOURCE);
        let id = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "Office.Item")
            .unwrap()
            .id;
        let data = program.effects.models.get_mut(&id).unwrap();
        if swapped {
            std::mem::swap(&mut data.uniques[0].id, &mut data.invariants[0].id);
        } else {
            data.uniques[0].id += 1;
        }
        let (ir, diagnostics) = ir::build(&program, &db, None);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(collect_checked_model_rule_origins(&program, &ir, &db, None).is_none());
        assert!(collect_checked_unique_conditions(&program, &ir, &db, None).is_none());
    }
}

#[test]
fn preferences_invariants_share_the_real_global_allocation_without_model_substitution() {
    let source=SOURCE.replacen(" Then\npackage Warehouse", " Then\n  preferences { enabled:bool=true }\n  invariant preferences: true\npackage Warehouse",1);
    let (db, program, ir) = checked(&source);
    let census = collect_checked_model_rule_origins(&program, &ir, &db, None).unwrap();
    assert_eq!(census.len(), 12);
    assert_eq!(census[8]["kind"], "invariant");
    let preferences = ir
        .items
        .iter()
        .find(|item| matches!(item.kind, IrItemKind::Preferences { .. }))
        .unwrap();
    assert_eq!(census[8]["model"], preferences.canonical);
    assert_eq!(census[8]["ownerPackage"], "Office");
    assert_eq!(census[8]["registryId"], "preferencesValid");
    assert_eq!(census[9]["model"], "Warehouse.Item");
}

#[test]
fn coordinated_checked_unique_fields_and_rebuilt_ir_cannot_replace_original_source() {
    for composite in [false, true] {
        let source = if composite {
            SOURCE.replace("fields=qty where=row.closed", "fields=qty,title")
        } else {
            SOURCE.to_string()
        };
        let (db, mut program, original) = checked(&source);
        assert!(collect_checked_model_rule_origins(&program, &original, &db, None).is_some());
        assert!(collect_checked_unique_conditions(&program, &original, &db, None).is_some());
        let model = program.symbols.iter().find(|s| s.canonical == "Office.Item").unwrap().id;
        let unique = &mut program.effects.models.get_mut(&model).unwrap().uniques[0];
        if composite {
            unique.fields.reverse();
        } else {
            unique.fields[0] = "title".into();
        }
        let (rebuilt, diagnostics) = ir::build(&program, &db, None);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(collect_checked_model_rule_origins(&program, &rebuilt, &db, None).is_none());
        assert!(collect_checked_unique_conditions(&program, &rebuilt, &db, None).is_none());
    }
    for changed_anchor in ["fields", "where"] {
        let (db, mut program, _) = checked(SOURCE);
        let model = program.symbols.iter().find(|s| s.canonical == "Office.Item").unwrap().id;
        let data = program.effects.models.get_mut(&model).unwrap();
        if changed_anchor == "fields" {
            data.uniques[0].fields_node = data.locks[0].fields_node;
        } else {
            data.uniques[0].where_predicate = data.invariants[0].predicate;
        }
        let (rebuilt, diagnostics) = ir::build(&program, &db, None);
        assert!(diagnostics.is_empty(), "{changed_anchor}: {diagnostics:?}");
        assert!(collect_checked_model_rule_origins(&program, &rebuilt, &db, None).is_none());
        assert!(collect_checked_unique_conditions(&program, &rebuilt, &db, None).is_none());
    }
}
