//! Explicit CALL slots retain their original reused type and literal default.
//! Installed descriptor correspondence grants no native CALL or row authority.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrDefault, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt,
};
use canlang_compiler::codegen::js::{self, JsFieldDefault, JsMcpField};
use canlang_compiler::codegen::scenario_calls::collect_static_scenario_calls;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

// The original Chat/Creative scalar type/default spellings, isolated on the
// existing empty root create and primitive-result profiles. Every slot is
// supplied; richer model inputs and actual application admission remain separate.
const SOURCE: &str = r#"app ExplicitInputs
use std {TextMessage,ImageRequest}
Given
 Run {count:int=0}
 judgment Choice version=1
  pick choice "Pick one" options=runtime {fallback="Fallback",other="Other"}
 policy Run read=members
When
 crud Run by=members fields=count delete=remove
 scenario ask(prompt:TextMessage.content) -> Run by=members
  do
   create Run {} as run
   return run
 scenario regenerate(prompt:text) -> Run by=members
  do
   call ask {prompt} as run
   return run
 scenario generate(prompt:ImageRequest.prompt,negative:ImageRequest.negative="",width:ImageRequest.width=512,height:ImageRequest.height=512) -> Run by=members
  do
   create Run {} as run
   return run
 scenario from_turn(prompt:text,negative:text,width:int,height:int) -> Run by=members
  do
   call generate {height,width,prompt,negative} as run
   return run
 scenario amount(prompt:TextMessage.content,count:int=1) -> int by=members
  do return count
 scenario primitive(prompt:text,count:int) -> int by=members
  do
   call amount {count,prompt}
   return 1
 scenario choice(value:Choice.pick.choice="fallback") -> int by=members
  do return 1
 scenario choice_parent(value:Choice.pick.choice) -> int by=members
  do
   call choice {value}
   return 1
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn checked(source: &str) -> (SourceDb, IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add("scenario-call-defaults.can".into(), source.into());
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, ir)
}
fn item<'a>(ir: &'a IrProgram, name: &str) -> &'a IrItem {
    ir.items.iter().find(|item| item.canonical == name).unwrap()
}
fn parameter(
    ir: &IrProgram,
    owner: &str,
    name: &str,
) -> canlang_compiler::analysis::resolve::SymbolId {
    let IrItemKind::Scenario { params, .. } = &item(ir, owner).kind else {
        panic!("scenario");
    };
    *params
        .iter()
        .find(|id| ir.items[id.0 as usize].name == name)
        .unwrap()
}
fn call_mut(
    ir: &mut IrProgram,
    owner: canlang_compiler::analysis::resolve::SymbolId,
) -> &mut IrStmt {
    let IrItemKind::Scenario { effects, .. } = &mut ir.items[owner.0 as usize].kind else {
        panic!("scenario");
    };
    effects
        .iter_mut()
        .find(|statement| matches!(statement, IrStmt::Call { .. }))
        .unwrap()
}

#[test]
fn explicit_scalar_calls_keep_authored_order_and_owning_default_alias_metadata() {
    let (db, ir) = checked(SOURCE);
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    for (parent, child, authored, declared) in [
        ("regenerate", "ask", vec!["prompt"], vec!["prompt"]),
        (
            "from_turn",
            "generate",
            vec!["height", "width", "prompt", "negative"],
            vec!["prompt", "negative", "width", "height"],
        ),
        (
            "primitive",
            "amount",
            vec!["count", "prompt"],
            vec!["prompt", "count"],
        ),
        ("choice_parent", "choice", vec!["value"], vec!["value"]),
    ] {
        let parent = item(&ir, &format!("ExplicitInputs.{parent}"));
        let child = item(&ir, &format!("ExplicitInputs.{child}"));
        assert!(matches!(
            ir.scenario_disclosures[&parent.id],
            ScenarioDisclosure::Complete(_)
        ));
        let sites = collect_static_scenario_calls(
            &ir,
            parent,
            &emitted.operations,
            &db,
            &emitted.entry.path,
        )
        .expect("complete explicit scalar CALL");
        assert_eq!(sites.len(), 1);
        let site = &sites[0];
        assert_eq!(site.target, child.canonical);
        assert_eq!(
            site.inputs
                .iter()
                .map(|input| input.name.as_str())
                .collect::<Vec<_>>(),
            authored
        );
        assert_eq!(
            site.interface
                .inputs
                .iter()
                .map(|input| input.name.as_str())
                .collect::<Vec<_>>(),
            declared
        );
        let operation = emitted
            .operations
            .iter()
            .find(|operation| operation.name == child.canonical)
            .unwrap();
        assert_eq!(site.interface.to_json(), operation.to_json());
        assert_eq!(
            emitted
                .entry
                .js
                .matches(&format!(
                    "await invokeScenarioReceiptCall(c,\"{}\"",
                    site.id
                ))
                .count(),
            1
        );
    }
    let generate = emitted
        .operations
        .iter()
        .find(|operation| operation.name == "ExplicitInputs.generate")
        .unwrap();
    let fields: serde_json::Value = serde_json::from_str(&generate.to_json()).unwrap();
    assert_eq!(fields["inputs"]["fields"][0]["required"], true);
    for (index, value) in [(1, ""), (2, "512"), (3, "512")] {
        assert_eq!(fields["inputs"]["fields"][index]["required"], false);
        assert_eq!(
            fields["inputs"]["fields"][index]["default"],
            serde_json::json!({"kind":"literal", "value":value})
        );
    }
    let choice = emitted
        .operations
        .iter()
        .find(|operation| operation.name == "ExplicitInputs.choice")
        .unwrap();
    let input = &choice.inputs[0];
    assert!(!input.required);
    assert_eq!(
        input.value_type.as_deref(),
        Some("ExplicitInputs.Choice.pick.choice")
    );
    assert!(
        matches!(&input.field, JsMcpField::Nominal { name } if name == "ExplicitInputs.Choice.pick.choice")
    );
    let constraints = ir
        .value_constraints
        .get(&parameter(&ir, "ExplicitInputs.choice", "value"))
        .unwrap();
    assert_eq!(
        (
            constraints.min,
            constraints.max,
            constraints.format.as_deref()
        ),
        (Some(1), Some(80), Some("name"))
    );
}

#[test]
fn changed_default_type_source_schema_constraints_and_argument_order_refuse() {
    let (db, ir) = checked(SOURCE);
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    let parent = item(&ir, "ExplicitInputs.from_turn").id;
    let width = parameter(&ir, "ExplicitInputs.generate", "width");
    let qualify = |changed: &IrProgram, operations: &[js::JsOperation], db: &SourceDb| {
        collect_static_scenario_calls(
            changed,
            &changed.items[parent.0 as usize],
            operations,
            db,
            &emitted.entry.path,
        )
    };
    assert!(qualify(&ir, &emitted.operations, &db).is_some());
    let mut source = SourceDb::new();
    source.add(
        "scenario-call-defaults.can".into(),
        SOURCE.replace("width=512", "width=513"),
    );
    assert!(qualify(&ir, &emitted.operations, &source).is_none());
    for mode in [
        "default-value",
        "default-span",
        "default-type",
        "computed-default",
        "missing-default",
        "constraints",
        "argument-order",
        "omitted",
        "duplicate",
    ] {
        let mut changed = ir.clone();
        if matches!(mode, "argument-order" | "omitted" | "duplicate") {
            let IrStmt::Call { inputs, .. } = call_mut(&mut changed, parent) else {
                panic!("CALL");
            };
            let IrExpr::Object(entries) = &mut inputs.expr else {
                panic!("inputs");
            };
            match mode {
                "argument-order" => entries.reverse(),
                "omitted" => {
                    entries.pop();
                }
                "duplicate" => entries[1].0 = entries[0].0.clone(),
                _ => unreachable!(),
            }
        } else if mode == "constraints" {
            changed.value_constraints.insert(width, Default::default());
        } else {
            let IrItemKind::Param { default, .. } = &mut changed.items[width.0 as usize].kind
            else {
                panic!("parameter");
            };
            let Some(IrDefault::Literal(value)) = default else {
                panic!("literal");
            };
            match mode {
                "default-value" => value.expr = IrExpr::Int(256),
                "default-span" => value.span.start += 1,
                "default-type" => value.ty = ResolvedType::Scalar(Scalar::Text),
                "computed-default" => {
                    *default = Some(IrDefault::Computed {
                        expr: value.clone(),
                        has_parent: false,
                    })
                }
                "missing-default" => *default = None,
                _ => unreachable!(),
            }
        }
        assert!(
            qualify(&changed, &emitted.operations, &db).is_none(),
            "{mode}"
        );
    }
    for mode in [
        "default",
        "missing-default",
        "required",
        "computed-default",
        "type",
        "field",
        "bound",
        "declaration-order",
    ] {
        let mut operations = emitted.operations.clone();
        let operation = operations
            .iter_mut()
            .find(|operation| operation.name == "ExplicitInputs.generate")
            .unwrap();
        if mode == "declaration-order" {
            operation.inputs.reverse();
        } else {
            let input = operation
                .inputs
                .iter_mut()
                .find(|input| input.name == "width")
                .unwrap();
            match mode {
                "default" => input.default = Some(JsFieldDefault::Literal("\"256\"".into())),
                "missing-default" => input.default = None,
                "required" => input.required = true,
                "computed-default" => input.computed_default = true,
                "type" => input.value_type = Some("bool".into()),
                "field" => input.field = JsMcpField::Boolean,
                "bound" => input.min = Some(1),
                _ => unreachable!(),
            }
        }
        assert!(
            qualify(&ir, &operations, &db).is_none(),
            "descriptor {mode}"
        );
    }
    let alias_parent = item(&ir, "ExplicitInputs.choice_parent").id;
    let alias_parameter = parameter(&ir, "ExplicitInputs.choice", "value");
    let mut changed = ir.clone();
    changed
        .value_constraints
        .get_mut(&alias_parameter)
        .unwrap()
        .max = Some(999);
    assert!(
        collect_static_scenario_calls(
            &changed,
            &changed.items[alias_parent.0 as usize],
            &emitted.operations,
            &db,
            &emitted.entry.path
        )
        .is_none()
    );
    let omitted = SOURCE.replace(
        "call generate {height,width,prompt,negative}",
        "call generate {height,prompt,negative}",
    );
    let (db, ir) = checked(&omitted);
    let parent = item(&ir, "ExplicitInputs.from_turn");
    assert!(matches!(
        ir.scenario_disclosures[&parent.id],
        ScenarioDisclosure::Declined(_)
    ));
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        collect_static_scenario_calls(&ir, parent, &emitted.operations, &db, &emitted.entry.path)
            .is_none()
    );
}

#[test]
fn actual_cli_verified_factory_and_installed_state_preserve_explicit_defaulted_inputs() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("scenario-call-defaults.can");
    std::fs::write(&source, SOURCE).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, output.stdout).unwrap();
    let runner = scratch.path().join("call-defaults.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact),factory=module.canApp();
const loaded=loadArtifactDescriptors(artifact,{by:'members'});
for(const [parent,child,result] of [['regenerate','ask','ExplicitInputs.Run'],['from_turn','generate','ExplicitInputs.Run'],['primitive','amount','int'],['choice_parent','choice','int']]) {
 const name=`ExplicitInputs.${parent}`,target=`ExplicitInputs.${child}`,operation=artifact.operations.find(operation=>operation.name===target);
 const callable=artifact.callables.find(callable=>callable.id===name),sites=module.appDefinition.operations[name].callSites;
 assert.equal(sites.length,1);assert.deepEqual(sites[0].targets,[target]);assert.equal(sites[0].resultType,result);
 assert.equal(module[callable.export],name);let handler=factory;for(const part of callable.member)handler=handler[part];assert.equal(typeof handler,'function');
 assert.equal(operation.result.type,result);
 const canonical=loaded.registry.get(target).descriptor.inputs;
 assert.deepEqual(canonical.map(input=>input.name),operation.inputs.fields.map(input=>input.name));
 for(const input of operation.inputs.fields) {
  const actual=canonical.find(field=>field.name===input.name);
  assert.equal(actual.kind,input.field.kind);assert.equal(actual.valueType,input.valueType);
  assert.equal(actual.required,input.required);assert.deepEqual(actual.default,input.default);
 }
 assert.deepEqual(sites[0].source,artifact.operations.find(operation=>operation.name===name).result.disclosure.source);
}
const input=name=>artifact.operations.find(operation=>operation.name==='ExplicitInputs.generate').inputs.fields.find(input=>input.name===name);
assert.deepEqual(artifact.operations.find(operation=>operation.name==='ExplicitInputs.generate').inputs.fields.map(input=>input.name),['prompt','negative','width','height']);
for(const [name,value] of [['negative',''],['width','512'],['height','512']]) {
 assert.equal(input(name).required,false);assert.deepEqual(input(name).default,{kind:'literal',value});assert.equal(Object.hasOwn(input(name),'computedDefault'),false);
}
const runtime=module.appDefinition.operations['ExplicitInputs.generate'].inputs;
assert.equal(runtime.negative.default,'');assert.equal(runtime.width.default,512n);assert.equal(runtime.height.default,512n);
const choice=artifact.operations.find(operation=>operation.name==='ExplicitInputs.choice').inputs.fields[0];
assert.equal(choice.valueType,'ExplicitInputs.Choice.pick.choice');assert.equal(choice.required,false);assert.deepEqual(choice.default,{kind:'literal',value:'fallback'});
const alias=loaded.valueTypes.aliases.find(alias=>alias.name===choice.valueType);
assert.equal(alias.min,1);assert.equal(alias.max,80);assert.equal(alias.format,'name');
// This is original-source and installed descriptor/factory correspondence.
// Dev owns genuine owner admission, child execution and current model authority.
console.log('CLI/verified factory/installed State retain explicit scalar CALL order, literal defaults and bounded alias metadata');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("modules"))
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&run.stdout));
}
