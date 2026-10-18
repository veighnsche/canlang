//! The table observation sees the genuine completed mutation, with native reads.
use std::{path::Path, process::Command};

const SOURCE: &str = r#"app ExampleOperation
Given
 Entry {source:text,request_source:text}
 policy Entry read=members
When
 scenario make(reject:bool=false) by=members
  require not reject
  do create Entry {source=operation.id,request_source=operation.source} as created
  examples
   as,reject -> count(Entry as entry where entry.source==operation.id and entry.request_source==operation.source),operation.source
   members,false -> 1,"example"
   members,true -> error(rule_failed)
   public,false -> error(forbidden)
   members,false -> 1,"example"
Then
"#;

fn compile(source: &str, path: &Path) -> std::process::Output {
    std::fs::write(path, source).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap()
}

#[test]
fn completed_mutation_context_preserves_correlation_and_native_rejections() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let compiled = compile(SOURCE, &scratch.path().join("operation.can"));
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stdout)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let unavailable = compile(
        &SOURCE.replace("1,\"example\"", "1,operation.source"),
        &scratch.path().join("expected.can"),
    );
    assert!(
        unavailable.status.success(),
        "{}",
        String::from_utf8_lossy(&unavailable.stdout)
    );
    std::fs::write(scratch.path().join("expected.json"), unavailable.stdout).unwrap();
    let script = r#"
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];
const {loadInstalledExampleTestkit,runCompiledExamples}=await import(pathToFileURL(resolve(root,'packages/cloudflare/dist/runtime/example-bindings.test-support.js')));
const testkit=await loadInstalledExampleTestkit(root);
const run=file=>runCompiledExamples({
 artifactBytes:readFileSync(new URL(file,import.meta.url)),artifactLabel:'operation.artifact.json',
 sourceRevision:'operation-context-fixture',workerName:`operation-context-${randomUUID()}`,
 worker:{mainModule:'main.mjs',modules:{'main.mjs':'export default {fetch(){return new Response(null,{status:404})}};'}},
 compatibilityDate:'2026-07-15',d1Binding:'DB',testkit,
});
const result=await run('./artifact.json');
assert.equal(result.ok,true,JSON.stringify(result.report));
assert.equal(result.executed,4);
assert.deepEqual(result.report.summary,{total:4,passed:4,failed:0,setupFailed:0,unsupported:0});
const rows=result.report.cases.find(c=>c.operation==='ExampleOperation.make').rows;
assert.deepEqual(rows.map(row=>row.outcome),['passed','passed','passed','passed']);
assert.deepEqual(rows.slice(1,3).map(row=>row.rejection),[
 {error:'rule_failed',sideEffectsAbsent:true},{error:'forbidden',sideEffectsAbsent:true}]);
const unavailable=await run('./expected.json');
assert.equal(unavailable.ok,false);
assert.deepEqual(unavailable.report.summary,{total:4,passed:2,failed:0,setupFailed:2,unsupported:0});
assert.match(JSON.stringify(unavailable.report),/no completed mutation operation context in this phase/);
"#;
    let runner = scratch.path().join("operation.mjs");
    std::fs::write(&runner, script).unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn operation_context_is_not_published_in_header_setup() {
    let scratch = tempfile::tempdir().unwrap();
    let source = SOURCE.replace("examples\n", "examples reject=operation.id==\"fake\"\n");
    let output = compile(&source, &scratch.path().join("unavailable.can"));
    assert!(!output.status.success());
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "E2001" && d["message"] == "unresolved name 'operation'"),
        "{result}"
    );
}
