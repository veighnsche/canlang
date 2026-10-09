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
    std::fs::write(&source, "app AliasProbe\nGiven\n judgment Choice version=1\n  pick choice \"Pick one\" options=runtime {fallback=\"Fallback\",other=\"Other\"}\n contract Payload {selected:Choice.pick.choice}\nWhen\n scenario intake(required:Choice.pick.choice,nullable:Choice.pick.choice?,optional:Choice.pick.choice=\"fallback\",many:Choice.pick.choice[],payload:Payload?,unmapped:Choice.pick.choice=\"other\") by=members\n  do let checked=1\nThen\n").unwrap();
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
import {createHash} from 'node:crypto';
const require=createRequire(process.argv[2]+'/package.json');
const load=specifier=>import(pathToFileURL(require.resolve(specifier)).href);
const {normalizeValueTypes,validateValue}=await load('@canlang/values');
const {artifactToDescriptorSet}=await load('@canlang/state/invocation/registry');
const {checkArtifactOperations,catalogFromArtifactOperations,createHttpHandler,handleCsvRequest}=await load('@canlang/interfaces');
const {createTestDeps,testRequest}=await load('@canlang/interfaces/testing');
const {deriveCsrfToken}=await load('@canlang/identity');
const {mintOperationId}=await load('@canlang/ui');
const {parseCsvGrammar}=await load('@canlang/ui/csv/grammar');
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
assert.deepEqual(inputs.unmapped.field,{kind:'nominal',name:alias});
assert.equal(inputs.unmapped.valueType,alias);
assert.deepEqual(inputs.unmapped.default,{kind:'literal',value:'other'});
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
const catalog=catalogFromArtifactOperations(artifact);
const t=await createTestDeps({mutations:{[operation.name]:envelope=>({result:{status:'committed',operation_id:envelope.operation_id}})}});
const csrf=await deriveCsrfToken(t.identity.sessionToken);
const deps={...t.deps,catalog};
const unused=async()=>new Response('unused',{status:500});
const http=createHttpHandler(deps,{operations:unused,auth:unused,uploads:unused,ingress:unused,oauth:unused,
 csv:request=>handleCsvRequest(deps,request)});
const post=(path,body)=>http(testRequest(path,{method:'POST',cookie:t.identity.cookie,
 headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)}));
const csv='required,nullable,optional,payload\nvalid_name,,,\n,,,\nbad name,,,\n'+'x'.repeat(81)+',,,\nother_name,,,\nvalid_name,,,"{""selected"":""fallback""}"\n';
const raw=parseCsvGrammar(csv);
const response=await post('/api/csv/review',{operation:operation.name,csv});
assert.equal(response.status,200,await response.clone().text());
const review=await response.json();
assert.deepEqual(review.rows.map(row=>row.status),['valid','invalid','invalid','invalid','valid','invalid']);
const candidates=[{required:'valid_name',nullable:null,payload:null},{required:'other_name',nullable:null,payload:null}];
assert.deepEqual(review.rows.filter(row=>row.status==='valid').map(row=>row.inputs),candidates);
for(const row of review.rows){
 assert.equal(Object.hasOwn(row.inputs,'optional'),false,'mapped defaulted blank stays omitted');
 assert.equal(Object.hasOwn(row.inputs,'unmapped'),false,'unmapped default stays omitted');
 assert.equal(Object.hasOwn(row.inputs,'many'),false,'unmapped array stays omitted');
 assert.equal(row.inputs.nullable,null);
 assert.equal(row.inputs.required,raw.rows[row.index].cells[0],'required raw candidate spelling survives');
}
assert.equal(Object.hasOwn(review.rows[1].inputs,'required'),true);
assert.equal(review.rows[1].inputs.required,'');
for(const index of [1,2,3]){
 assert.equal(review.rows[index].error.code,'validation');
 assert.equal(review.rows[index].error.fields[0].path,'/required');
 assert.equal(review.rows[index].error.fields[0].code,'binding_mismatch');
}
assert.equal(review.rows[5].inputs.payload,'{"selected":"fallback"}');
assert.equal(review.rows[5].error.fields[0].path,'/payload');
assert.equal(review.rows[5].error.fields[0].code,'binding_mismatch');
// Independent golden serialization covers the exact valid raw candidates only.
const golden='{"candidates":[{"nullable":null,"payload":null,"required":"valid_name"},{"nullable":null,"payload":null,"required":"other_name"}],"operation":"AliasProbe.intake"}';
const digest=createHash('sha256').update(golden).digest('hex');
const consent={review_id:'rev-'+digest.slice(0,16),operation:operation.name,principal:t.identity.userId,
 candidates_digest:digest,candidate_count:2};
assert.deepEqual(review.consent,consent);
assert.equal(t.invoker.mutations.length,0,'review never invokes');
const repeated=await post('/api/csv/review',{operation:operation.name,csv});
assert.equal(repeated.status,200);
assert.deepEqual((await repeated.json()).consent,consent);
const selections=review.rows.map(row=>({index:row.index,operation_id:mintOperationId()}));
const committed=await post('/api/csv/commit',{operation:operation.name,csv,consent,rows:selections});
assert.equal(committed.status,200,await committed.clone().text());
const outcome=await committed.json();
assert.deepEqual(outcome.rows.map(row=>row.status),['committed','invalid','invalid','invalid','committed','invalid']);
assert.equal(t.invoker.mutations.length,2,'only valid rows invoke');
assert.deepEqual(t.invoker.mutations.map(call=>call.envelope.inputs),candidates,'valid invocation order follows source rows');
assert.deepEqual(t.invoker.mutations.map(call=>call.envelope.operation_id),[selections[0].operation_id,selections[4].operation_id]);
assert.deepEqual(parseCsvGrammar(csv),raw);
assert.deepEqual(review.consent,consent);
console.log('actual alias descriptors: State/Interfaces intake, bounded codec and mounted CSV review/commit passed');
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
