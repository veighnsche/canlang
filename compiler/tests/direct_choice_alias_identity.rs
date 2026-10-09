//! Direct declaration types retain the owning checked bounded alias identity.
use canlang_compiler::{
    analysis::{
        check_program,
        resolve::SymbolKind,
        types::{ResolvedType, Scalar},
    },
    codegen::ir,
    source::SourceDb,
};

#[test]
fn direct_choice_alias_parameters_retain_identity_and_wrappers_in_ir() {
    let source = "app AliasProbe\nGiven\n judgment Choice version=1\n  pick choice \"Pick one\" options=runtime {fallback=\"Fallback\",other=\"Other\"}\n contract Payload {selected:Choice.pick.choice}\nWhen\n scenario intake(required:Choice.pick.choice,nullable:Choice.pick.choice?,optional:Choice.pick.choice=\"fallback\",many:Choice.pick.choice[],payload:Payload?) by=members\n  do let checked=1\nThen\n";
    let mut db = SourceDb::new();
    let file = db.add("direct-alias.can".into(), source.into());
    let (checked, diagnostics) = check_program(&db, &[file], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = ir::build(&checked, &db, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let alias = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "AliasProbe.Choice.pick.choice")
        .unwrap()
        .id;
    for name in ["required", "nullable", "optional", "many"] {
        let symbol = checked
            .symbols
            .iter()
            .find(|symbol| symbol.name == name && matches!(symbol.kind, SymbolKind::Param { .. }))
            .unwrap();
        let constraints = program.value_constraints.get(&symbol.id).unwrap();
        assert_eq!(constraints.alias, Some(alias), "{name}");
        assert_eq!(
            program.item(alias).canonical,
            "AliasProbe.Choice.pick.choice"
        );
        let ir::IrItemKind::Param { ty, default, .. } = &program.item(symbol.id).kind else {
            panic!("parameter IR")
        };
        match (name, ty) {
            ("required" | "optional", ir::IrType::Known(ResolvedType::Scalar(Scalar::Text))) => {}
            ("nullable", ir::IrType::Known(ResolvedType::Nullable(inner))) => {
                assert_eq!(**inner, ResolvedType::Scalar(Scalar::Text))
            }
            ("many", ir::IrType::Known(ResolvedType::Array { element, .. })) => {
                assert_eq!(**element, ResolvedType::Scalar(Scalar::Text))
            }
            _ => panic!("{name}: {ty:?}"),
        }
        assert_eq!(default.is_some(), name == "optional");
        if name == "many" {
            assert_eq!(
                (
                    constraints.min,
                    constraints.max,
                    constraints.format.as_deref()
                ),
                (None, None, None)
            );
        } else {
            assert_eq!(
                (
                    constraints.min,
                    constraints.max,
                    constraints.format.as_deref()
                ),
                (Some(1), Some(80), Some("name"))
            );
        }
    }
    let payload = checked
        .symbols
        .iter()
        .find(|symbol| symbol.name == "payload" && matches!(symbol.kind, SymbolKind::Param { .. }))
        .unwrap();
    assert!(!program.value_constraints.contains_key(&payload.id));
}

#[test]
fn direct_alias_artifact_reaches_checked_nominal_consumers() {
    use std::{path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("direct-alias.can");
    std::fs::write(&source, "app AliasProbe\nGiven\n judgment Choice version=1\n  pick choice \"Pick one\" options=runtime {fallback=\"Fallback\",other=\"Other\"}\n contract Payload {selected:Choice.pick.choice}\nWhen\n scenario intake(required:Choice.pick.choice,nullable:Choice.pick.choice?,optional:Choice.pick.choice=\"fallback\",many:Choice.pick.choice[],payload:Payload?) by=members\n  do let checked=1\nThen\n").unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, &compiled.stdout).unwrap();
    let runner = scratch.path().join("run.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(process.argv[2]+'/package.json');
const load=specifier=>import(pathToFileURL(require.resolve(specifier)).href);
const {normalizeValueTypes,validateValue}=await load('@canlang/values');
const {artifactToDescriptorSet}=await load('@canlang/state/invocation/registry');
const {checkArtifactOperations}=await load('@canlang/interfaces');
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const operation=artifact.operations.find(op=>op.name==='AliasProbe.intake');
const alias='AliasProbe.Choice.pick.choice';
const inputs=Object.fromEntries(operation.inputs.fields.map(input=>[input.name,input]));
for(const [name,type] of [['required',alias],['nullable',alias+'?'],['optional',alias],['many',alias+'[]']]){
 assert.deepEqual(inputs[name].field,{kind:'nominal',name:alias});
 assert.equal(inputs[name].valueType,type);
}
assert.equal(inputs.required.required,true);
assert.equal(inputs.nullable.nullable,true);
assert.equal(inputs.nullable.required,false);
assert.equal(inputs.optional.required,false);
assert.deepEqual(inputs.optional.default,{kind:'literal',value:'fallback'});
assert.deepEqual(inputs.many.array,{required:false});
assert.equal(inputs.many.required,false);
assert.deepEqual(inputs.payload.field,{kind:'nominal',name:'AliasProbe.Payload'});
assert.equal(inputs.payload.valueType,'AliasProbe.Payload?');
const canonical=artifactToDescriptorSet(artifact).set.operations.find(op=>op.name===operation.name);
assert.equal(canonical.inputs[0].kind,'nominal');
assert.equal(canonical.inputs[0].valueType,alias);
assert.ok(checkArtifactOperations(artifact).some(op=>op.name===operation.name));
const {valueSchema}=normalizeValueTypes(artifact.valueTypes);
for(const valid of ['fallback','other','valid_name']) validateValue(valueSchema,alias,valid,'create');
validateValue(valueSchema,alias+'?',null,'create');
validateValue(valueSchema,alias+'[]',['fallback'],'create');
for(const invalid of ['', 'bad name','x'.repeat(81)]){
 for(const type of [alias,alias+'?']) assert.throws(()=>validateValue(valueSchema,type,invalid,'create'));
 assert.throws(()=>validateValue(valueSchema,alias+'[]',[invalid],'create'));
}
console.log('actual alias descriptors: owning State/Interfaces intake and bounded nominal codec passed');
"#).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(artifact)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
