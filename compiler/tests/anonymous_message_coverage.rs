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
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E3001"),
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
 export derive rawSame():int=count(["Hi"@{},"Hi"@{}])
 export derive rawDifferent():int=count(["Hi"@{},"Bye"@{nl="Dag"}])
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
for(const name of ['rawSame','rawDifferent']) assert.equal(await registry['DescriptorArrays.'+name](context),2n);
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
trace.length=0;
const first=new Error('first descriptor operand');
const broken={get n(){trace.push('n');throw first},get label(){trace.push('label');return 'unreached'}};
await assert.rejects(registry['DescriptorArrays.boundDifferent'](context,broken),error=>error===first);
assert.deepEqual(trace,['n'],'an earlier descriptor failure skips the later array construction');
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
