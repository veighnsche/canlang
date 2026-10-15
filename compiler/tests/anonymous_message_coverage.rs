//! The actual CLI refuses unbound inline-format variables before emission.
use std::{path::Path, process::Command};

#[test]
fn anonymous_localized_format_uses_its_checked_empty_parameter_schema() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let run = |command: &str, declaration: &str| {
        let source = format!("app Anonymous\nGiven\n {declaration}\nWhen\nThen\n");
        let input = scratch.path().join("inline.can");
        std::fs::write(&input, &source).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let output =
            canlang_compiler::json::parse(&String::from_utf8_lossy(&result.stdout)).unwrap();
        (source, result, output)
    };
    for expression in [
        "format(\"Hello\"@{nl=\"Dag\"},locale=null)",
        "format(locale=null,descriptor=\"Hello\"@{})",
        "format(\"'{d,time}'\"@{},locale=null)",
        "format(\"{d}\",{d=\"plain\"})",
    ] {
        let (_, result, output) = run("compile", &format!("derive shown():text = {expression}"));
        assert!(result.status.success(), "{expression}: {output:?}");
        assert!(!output.get("modules").unwrap().as_arr().unwrap().is_empty());
    }
    // An unrelated raw descriptor remains structurally checked without being
    // misdeclared as a text result or selected as an empty-schema format.
    let (_, result, output) = run("check", "derive shown():int = count([\"{d,time}\"@{}])");
    assert!(result.status.success(), "{output:?}");
    assert!(
        output
            .get("diagnostics")
            .unwrap()
            .as_arr()
            .unwrap()
            .is_empty()
    );
    for (expression, literal) in [
        ("format(\"{d,time}\"@{},locale=null)", "\"{d,time}\""),
        ("format(((\"{d,time}\"@{})),locale=null)", "\"{d,time}\""),
        (
            "format(locale=null,descriptor=(\"{d,time}\"@{}))",
            "\"{d,time}\"",
        ),
        (
            "format(\"Hello\"@{nl=\"{d,time,short}\"},locale=null)",
            "\"{d,time,short}\"",
        ),
        ("format(\"{d,time,xx}\"@{},locale=null)", "\"{d,time,xx}\""),
        ("format(\"{d}\"@{},locale=null)", "\"{d}\""),
        (
            "format(\"{kind,select,other {ok}}\"@{},locale=null)",
            "\"{kind,select,other {ok}}\"",
        ),
    ] {
        let (source, result, output) =
            run("compile", &format!("derive shown():text = {expression}"));
        assert_eq!(result.status.code(), Some(10), "{expression}: {output:?}");
        assert!(output.get("modules").is_none(), "refusal emitted modules");
        let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
        assert_eq!(diagnostics.len(), 1, "{expression}: {output:?}");
        let diagnostic = &diagnostics[0];
        assert_eq!(diagnostic.get("code").unwrap().as_str(), Some("E5007"));
        let variable = if expression.contains("kind,select") {
            "kind"
        } else {
            "d"
        };
        assert_eq!(diagnostic.get("message").unwrap().as_str(), Some(format!("invalid message pattern: message pattern uses undeclared variable {{{variable}}}").as_str()));
        let primary = diagnostic.get("primary").unwrap();
        let start = source.find(literal).unwrap();
        assert_eq!(primary.get("start").unwrap().as_i64(), Some(start as i64));
        assert_eq!(
            primary.get("end").unwrap().as_i64(),
            Some((start + literal.len()) as i64)
        );
    }
    let (source, result, output) = run(
        "compile",
        "message label(seed:text=format(\"{d}\"@{},locale=null))=\"{seed}\"@{}",
    );
    assert_eq!(result.status.code(), Some(10), "{output:?}");
    assert!(output.get("modules").is_none());
    let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
    assert_eq!(diagnostics.len(), 1, "{output:?}");
    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.get("code").unwrap().as_str(), Some("E5007"));
    assert_eq!(
        diagnostic.get("message").unwrap().as_str(),
        Some("invalid message pattern: message pattern uses undeclared variable {d}")
    );
    let start = source.find("\"{d}\"").unwrap();
    let primary = diagnostic.get("primary").unwrap();
    assert_eq!(primary.get("start").unwrap().as_i64(), Some(start as i64));
    assert_eq!(
        primary.get("end").unwrap().as_i64(),
        Some((start + 5) as i64)
    );
}

#[test]
fn anonymous_descriptor_arrays_refuse_text_and_named_schema_mixing() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    for declaration in [
        "derive shown():int=count([\"Hi\"@{},\"literal\"])",
        "derive shown():int=count([\"literal\",\"Hi\"@{}])",
        "derive shown(n:int):int=count([\"{n}\"@{}(n=n),\"literal\"])",
        "derive shown():int=count([named,\"Hi\"@{}])",
        "derive shown():int=count([choose(true,\"Hi\"@{},\"literal\")])",
        "derive shown():int=count([choose(false,\"literal\",\"Hi\"@{})])",
        "derive shown():int=count([choose(true,named,\"Hi\"@{})])",
        "derive shown():int=count([choose(false,\"Hi\"@{},named)])",
        "derive shown():text[]=[\"Hi\"@{},\"Bye\"@{}]",
        "derive shown(n:int):text[]=[\"Hi\"@{},\"{n}\"@{}(n=n)]",
    ] {
        let source = format!(
            "app DescriptorArrayNegative\nGiven\n message named=\"Hi\"@{{}}\n {declaration}\nWhen\nThen\n"
        );
        let input = scratch.path().join("negative.can");
        std::fs::write(&input, source).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let output: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(result.status.code(), Some(10), "{declaration}: {output}");
        assert!(output.get("modules").is_none(), "{declaration}: {output}");
        let diagnostics = output["diagnostics"].as_array().unwrap();
        assert!(
            diagnostics.iter().any(|diagnostic| {
                diagnostic["code"]
                    == if declaration.contains("choose(") {
                        "E3005"
                    } else {
                        "E3001"
                    }
            }),
            "{declaration}: {output}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| !diagnostic["code"].as_str().unwrap().starts_with("E1")),
            "negative must parse: {declaration}: {output}"
        );
    }
}

#[cfg(unix)]
#[test]
fn anonymous_descriptor_arrays_check_compile_and_count_captured_values() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let source = r#"app DescriptorArrays source="fr"
Given
 contract Inputs {n:int,label:text}
 export derive businessLabels():text[]=["Open task","Review invoice"]
 export derive businessLabelCount():int=count(businessLabels())
 export derive rawSame():int=count(["Hi"@{},"Hi"@{}])
 export derive rawDifferent():int=count(["Hi"@{},"Bye"@{nl="Dag"}])
 export derive chosen(condition:bool,value:Inputs):int=count([choose(condition,"{n}"@{}(n=value.n),"{label}"@{}(label=value.label))])
 export derive rawGrouped():int=count([(("Hi"@{})),("Bye"@{nl="Dag"})])
 export derive boundSame(value:Inputs):int=count(["{n}"@{}(n=value.n),"{n}"@{}(n=value.n)])
 export derive boundDifferent(value:Inputs):int=count(["{n}"@{}(n=value.n),"{label}"@{}(label=value.label)])
 export derive rawAndBound(value:Inputs):int=count(["Hi"@{},"{n}"@{}(n=value.n)])
When
 export scenario repeatedRaw() -> int by=members
  do
   let descriptor="Hi"@{}
   let alias=((descriptor))
   return count([descriptor,alias,((alias))])
 export scenario repeatedBound(value:Inputs) -> int by=members
  do
   let descriptor="{n}|{label}"@{}(label=value.label,n=value.n)
   let alias=((descriptor))
   let final=alias
   return count([descriptor,alias,((final))])
Then
"#;
    let input = scratch.path().join("arrays.can");
    let artifact = scratch.path().join("arrays.json");
    std::fs::write(&input, source).unwrap();
    for command in ["check", "compile"] {
        let result = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let output: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert!(result.status.success(), "{command}: {output}");
        if command == "check" {
            assert!(
                output["diagnostics"].as_array().unwrap().is_empty(),
                "{command}: {output}"
            );
        } else {
            assert_eq!(output["artifact_version"], 1, "{command}: {output}");
            assert!(!output["modules"].as_array().unwrap().is_empty());
            std::fs::write(&artifact, &result.stdout).unwrap();
        }
    }
    let script = r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {assembleModules} from '@canlang/cloudflare/runtime/modules';
const [artifactPath,sourcePath,scratch]=process.argv.slice(1);
const assembled=await assembleModules({artifact:JSON.parse(readFileSync(artifactPath,'utf8')),sourcePath}, {
 workDir:resolve(scratch,'modules'),stdlibUrl:import.meta.resolve('@canlang/stdlib'),uiUrl:import.meta.resolve('@canlang/ui'),
});
const registry=(await import(assembled.entryUrl)).canApp();
const context={memberships:['members']};
assert.deepEqual(await registry['DescriptorArrays.businessLabels'](context),['Open task','Review invoice']);
assert.equal(await registry['DescriptorArrays.businessLabelCount'](context),2n);
for(const name of ['rawSame','rawDifferent','rawGrouped']) assert.equal(await registry['DescriptorArrays.'+name](context),2n);
const trace=[];
const value={get n(){trace.push('n');return 1n},get label(){trace.push('label');return 'task'}};
assert.equal(await registry['DescriptorArrays.boundSame'](context,value),2n);
assert.deepEqual(trace,['n','n'],'two authored constructions evaluate both operands');
trace.length=0;
assert.equal(await registry['DescriptorArrays.boundDifferent'](context,value),2n);
assert.deepEqual(trace,['n','label'],'different checked descriptor schemas retain source order');
trace.length=0;
assert.equal(await registry['DescriptorArrays.rawAndBound'](context,value),2n);
assert.deepEqual(trace,['n']);
assert.equal(await registry['DescriptorArrays.repeatedRaw'](context,{}),3n);
trace.length=0;
assert.equal(await registry['DescriptorArrays.repeatedBound'](context,{value}),3n);
assert.deepEqual(trace,['label','n'],'repeated immutable reads do not rebind their captured operands');
for(const condition of [true,false]) {
 trace.length=0;
 assert.equal(await registry['DescriptorArrays.chosen'](context,condition,value),1n);
 assert.deepEqual(trace,['n','label'],'choose captures both authored descriptor arguments once in order');
}
trace.length=0;
const first=new Error('first descriptor operand');
const broken={get n(){trace.push('n');throw first},get label(){trace.push('label');return 'unreached'}};
await assert.rejects(registry['DescriptorArrays.boundDifferent'](context,broken),error=>error===first);
assert.deepEqual(trace,['n'],'an earlier descriptor failure skips the later array construction');
for(const condition of [true,false]) {
 trace.length=0;
 await assert.rejects(registry['DescriptorArrays.chosen'](context,condition,broken),error=>error===first);
 assert.deepEqual(trace,['n'],'first choose argument failure skips its later descriptor argument');
}
console.log('descriptor arrays: exact counts, authored construction order, repeated captured aliases and first failure passed');
"#;
    let result = Command::new("node")
        .args(["--input-type=module", "--eval", script])
        .arg(&artifact)
        .arg(&input)
        .arg(scratch.path())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn computed_message_formats_validate_every_reachable_descriptor() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    for (expression, expected) in [
        (
            "format(choose(true,\"Hi\"@{},\"{unknown}\"@{}),locale=null)",
            "E5007",
        ),
        (
            "format(choose(true,\"Hi\"@{},\"Bye\"@{nl=\"{unknown}\"}),locale=null)",
            "E5007",
        ),
        (
            "format(choose(true,\"Hi\"@{},choose(false,\"{unknown}\"@{},\"Bye\"@{})),locale=null)",
            "E5007",
        ),
        (
            "format(choose(true,\"Hi\"@{},\"ordinary text\"),locale=null)",
            "E3005",
        ),
        ("format(choose(true,\"Hi\"@{},named),locale=null)", "E3005"),
        ("format(choose(true,\"Hi\"@{},null),locale=null)", "E3005"),
    ] {
        let input = scratch.path().join("computed-negative.can");
        std::fs::write(
            &input,
            format!(
                "app ComputedNegative\nGiven\n message named=\"Hi\"@{{}}\n derive shown():text={expression}\nWhen\nThen\n"
            ),
        )
        .unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let output: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(result.status.code(), Some(10), "{expression}: {output}");
        assert!(output.get("modules").is_none(), "{expression}: {output}");
        let diagnostics = output["diagnostics"].as_array().unwrap();
        assert!(
            diagnostics
                .iter()
                .any(|finding| finding["code"] == expected),
            "{expression}: {output}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|finding| !finding["code"].as_str().unwrap().starts_with("E1")),
            "negative must parse: {expression}: {output}"
        );
    }
}

#[cfg(unix)]
#[test]
fn computed_message_formats_execute_selected_schemas_without_rebinding() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let source = r#"app ComputedFormats source="FR"
Given
 contract Inputs {condition:bool,other:bool,n:int,label:text,target:locale?}
 export derive raw(condition:bool):text=format(choose(condition,"Salut"@{},"Au revoir"@{}),locale=null)
 export derive bound(value:Inputs):text=format(choose(value.condition,"Nombre {n}"@{nl="Aantal {n}"}(n=value.n),"Mot {label}"@{nl="Woord {label}"}(label=value.label)),locale=value.target)
 export derive sameSlot(value:Inputs):text=format(choose(value.condition,"{value,number}"@{nl="Getal {value,number}"}(value=value.n),"{value}"@{nl="Tekst {value}"}(value=value.label)),locale=value.target)
 export derive reordered(value:Inputs):text=format(choose(value.condition,"A {n}|{label}"@{nl="Eén {n}|{label}"}(n=value.n,label=value.label),"B {n}|{label}"@{nl="Twee {n}|{label}"}(label=value.label,n=value.n)),locale=value.target)
 export derive localeFirst(value:Inputs):text=format(locale=value.target,descriptor=choose(value.condition,"Nombre {n}"@{nl="Aantal {n}"}(n=value.n),"Mot {label}"@{nl="Woord {label}"}(label=value.label)))
 export derive nested(value:Inputs):text=format(((choose(value.condition,((choose(value.other,"Nombre {n}"@{nl="Aantal {n}"}(n=value.n),"Mot {label}"@{nl="Woord {label}"}(label=value.label)))),"Fin"@{}))),locale=value.target)
When
 export scenario aliased(value:Inputs) -> text by=members
  do
   let selected=choose(value.condition,"Nombre {n}"@{nl="Aantal {n}"}(n=value.n),"Mot {label}"@{nl="Woord {label}"}(label=value.label))
   let alias=((selected))
   let formatted=format(((alias)),locale=value.target)
   return "aliased"
Then
"#;
    let input = scratch.path().join("computed.can");
    let artifact = scratch.path().join("computed.json");
    std::fs::write(&input, source).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let output: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(result.status.success(), "{output}");
    assert!(!output["modules"].as_array().unwrap().is_empty());
    std::fs::write(&artifact, &result.stdout).unwrap();
    let script = r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assembleModules} from '@canlang/cloudflare/runtime/modules';
const [artifactPath,sourcePath,scratch]=process.argv.slice(1);
// Observe the actual installed formatter's result for a scenario-local value.
const stdlib=JSON.stringify(import.meta.resolve('@canlang/stdlib'));
const observed=resolve(scratch,'observed-stdlib.mjs');
globalThis.computedFormatted=[];
writeFileSync(observed,`export * from ${stdlib};import {format as actual} from ${stdlib};export function format(...args){const result=actual(...args);globalThis.computedFormatted.push(result);return result}`);
const assembled=await assembleModules({artifact:JSON.parse(readFileSync(artifactPath,'utf8')),sourcePath},{
 workDir:resolve(scratch,'modules'),stdlibUrl:pathToFileURL(observed).href,uiUrl:import.meta.resolve('@canlang/ui'),
});
const registry=(await import(assembled.entryUrl)).canApp();
const context={formatting:{appDefault:'nl'},team:null,memberships:['members']};
for(const [condition,text] of [[true,'Salut'],[false,'Au revoir']]) {
 assert.deepEqual(await registry['ComputedFormats.raw']({...context,formatting:{appDefault:'es'}},condition),{text,locale:'fr'},'selected raw descriptor preserves canonical owning source locale');
}
const trace=[];
function observedInput(condition=true,other=false,target=null,fail) {
 const values={condition,other,n:7n,label:'tâche',target};
 return Object.defineProperties({},Object.fromEntries(Object.keys(values).map(name=>[name,{get(){trace.push(name);if(name===fail)throw failure;return values[name]}}])));
}
const failure=new Error('first failing operand');
for(const [condition,text] of [[true,'Aantal 7'],[false,'Woord tâche']]) {
 trace.length=0;
 assert.deepEqual(await registry['ComputedFormats.bound'](context,observedInput(condition)),{text,locale:'nl'});
 assert.deepEqual(trace,['condition','n','label','target'],'both distinct bound schemas capture eagerly once');
 trace.length=0;
 assert.deepEqual(await registry['ComputedFormats.localeFirst'](context,observedInput(condition)),{text,locale:'nl'});
 assert.deepEqual(trace,['target','condition','n','label'],'named arguments retain authored locale-first evaluation');
 trace.length=0;
 globalThis.computedFormatted.length=0;
 assert.equal(await registry['ComputedFormats.aliased'](context,{value:observedInput(condition)}),'aliased');
 assert.deepEqual(globalThis.computedFormatted,[{text,locale:'nl'}],'immutable aliases format the selected captured schema');
 assert.deepEqual(trace,['condition','n','label','target'],'alias reads never recapture operands');
}
for(const [condition,text] of [[true,'Getal 7'],[false,'Tekst tâche']]) {
 trace.length=0;
 assert.deepEqual(await registry['ComputedFormats.sameSlot'](context,observedInput(condition)),{text,locale:'nl'},'same slot selects the checked canonical int or text type');
 assert.deepEqual(trace,['condition','n','label','target']);
}
for(const [condition,text] of [[true,'Eén 7|tâche'],[false,'Twee 7|tâche']]) {
 trace.length=0;
 assert.deepEqual(await registry['ComputedFormats.reordered'](context,observedInput(condition)),{text,locale:'nl'},'equal name/type schemas match independently of authored capture order');
 assert.deepEqual(trace,['condition','n','label','label','n','target'],'schema matching does not reorder or repeat either eager operand capture');
}
for(const [condition,other,text] of [[true,true,'Aantal 7'],[true,false,'Woord tâche'],[false,true,'Fin']]) {
 trace.length=0;
 const result=await registry['ComputedFormats.nested'](context,observedInput(condition,other));
 assert.deepEqual(result,{text,locale:condition?'nl':'fr'});
 assert.deepEqual(trace,['condition','other','n','label','target'],'nested grouped choices retain every eager operand');
}
assert.deepEqual(await registry['ComputedFormats.bound'](context,{condition:false,other:false,n:7n,label:'tâche',target:'fr'}),{text:'Mot tâche',locale:'fr'},'explicit locale formats the selected text schema');
for(const [name,order] of [['bound',['condition','n','label','target']],['localeFirst',['target','condition','n','label']]]) {
 for(const fail of order) {
  trace.length=0;
  await assert.rejects(registry['ComputedFormats.'+name](context,observedInput(false,false,null,fail)),error=>error===failure);
  assert.deepEqual(trace,order.slice(0,order.indexOf(fail)+1),'first failure stops later operands without replacement');
 }
}
console.log('computed formats: selected schemas/locales, eager operands, aliases and first failure passed');
"#;
    let result = Command::new("node")
        .args(["--input-type=module", "--eval", script])
        .arg(&artifact)
        .arg(&input)
        .arg(scratch.path())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
