//! Source alias and unchanged emitted native ABI only; the installed stdlib
//! delivery observation facade remains a separate package-owned seam.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn declared_progress_alias_observes_the_existing_result_once() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    // This compiler consumer pins whole/child grants while the package fixture
    // continues to grow its own page and policy coverage.
    let source = std::fs::read_to_string(root.join("packages/cloudflare/test/fixtures/typed-generation-progress.can"))
        .unwrap()
        .lines()
        .filter(|line| !line.trim_start().starts_with("policy Job "))
        .collect::<Vec<_>>()
        .join("\n")
        .replace("When\n", " policy Job read=members fields=label,request.status,request.progress\n policy Job read=members fields=request.progress.content\n contract Counter {progress:text}\n derive content(job:Job):text = job.request?.progress?.content ?? \"\"\n derive resultContent(job:Job):text = job.request?.result?.content ?? \"\"\n derive isRunning(job:Job):bool = job.request?.progress?.state == running\n derive detail(job:Job):text = job.request?.progress?.detail ?? \"\"\n derive stateMissing(job:Job):bool = job.request?.progress?.state == null\n derive statePresent(job:Job):bool = job.request?.progress?.state != null\n derive missingStateReverse(job:Job):bool = null == job.request?.progress?.state\n derive presentStateReverse(job:Job):bool = null != job.request?.progress?.state\n derive ordinary(value:Counter):text = value.progress\nWhen\n");
    let source = source.replace("When\n", "When\n scenario progressCaption(job:Job) read=true -> text by=members\n  do\n   let state=job.request?.progress?.state\n   if state!=null\n    match state\n     case queued\n      return \"queued\"\n     case running\n      return \"running\"\n     case succeeded\n      return \"succeeded\"\n     case failed\n      return \"failed\"\n     case unknown\n      return \"unknown\"\n     case cancelled\n      return \"cancelled\"\n   else\n    return \"Missing\"\n");
    let input = scratch.path().join("progress.can");
    std::fs::write(&input, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();
    let stdlib = scratch.path().join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(stdlib.join("index.mjs"), r#"
import assert from 'node:assert/strict';
export {ValueError,int64} from __VALUE_ERROR_MODULE__;
export function hasRole(context,role){return context.memberships.includes(role);}
export function require(condition){if(!condition)throw Error('require');}
export function equalValue(...args){return globalThis.probe.equalValue(...args);}
export async function delivery(context,locator,selected){
 const probe=globalThis.probe;assert.equal(context,probe.context);assert.equal(locator.record,probe.record);assert.equal(locator.field,'request');assert.deepEqual(selected,[probe.expectedKey]);
 const key=selected[0];probe.trace.push(['delivery',key]);
 if(!context.memberships.includes('members')||!(probe.grants.mayObserve('result',{field:'request'})||probe.paths.has(`request.${key}`)))throw Error('denied');
 if(probe.absentAssociation)return null;
 return {[key]:probe.result===null?null:key==='result'?probe.result:probe.result[key.slice('result.'.length)]};
}
export async function send(){throw Error('unused send');}
export async function set(){throw Error('unused set');}
export async function create(){throw Error('unused create');}
export async function deleteRecord(){throw Error('unused delete');}
"#.replace("__VALUE_ERROR_MODULE__", &serde_json::to_string(&root.join("packages/stdlib/dist/src/index.js").display().to_string()).unwrap())).unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules/@canlang/ui"),
        scratch.path().join("node_modules/@canlang/ui"),
    )
    .unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=process.argv[2],base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path))),registry=entry.canApp();
const grants=entry.appDefinition.models['TypedGenerationProgress.Job'].readGrants;
assert.deepEqual(grants.map(grant=>grant.fields),[['label','request.status','request.result'],['request.result.content']]);
const require=createRequire(resolve(root,'package.json'));
const {createSelectedGrants}=await import(pathToFileURL(require.resolve('@canlang/state/receipt/grants')));
const whole=createSelectedGrants({field:'request',paths:new Set(grants[0].fields)});
const child=createSelectedGrants({field:'request',paths:new Set(grants[1].fields)});
assert.equal(whole.mayObserve('result',{field:'request'}),true);
assert.equal(child.mayObserve('result',{field:'request'}),false,'a child grant never expands upward');
const model=artifact.models.find(model=>model.name==='TypedGenerationProgress.Job');
const descriptor=model.fields.find(field=>field.name==='request').field;
assert.equal(descriptor.kind,'delivery');assert.equal(descriptor.result.name,'TextRun');assert(descriptor.result.fields.some(field=>field.name==='state'));assert(descriptor.result.fields.some(field=>field.name==='content'));assert(descriptor.result.fields.some(field=>field.name==='detail'));
const {equalValue}=await import(pathToFileURL(resolve(root,'packages/values/dist/src/index.js')));
const context={memberships:['members']},record={id:'job'},trace=[];
const result={source:'source',revision:1n,sequence:1n,used_tokens:null};
for(const [field,value]of [['state','running'],['content','Draft'],['detail','Preparing']])Object.defineProperty(result,field,{get(){trace.push(['read',field]);return value;}});
globalThis.probe={context,record,trace,result,grants:whole,paths:new Set(grants[0].fields),expectedKey:null,equalValue};
function callable(name){const descriptor=artifact.callables.find(callable=>callable.id===`TypedGenerationProgress.${name}`);assert(descriptor,name);let fn=registry;for(const part of descriptor.member)fn=fn[part];return fn;}
for(const [name,expected,field]of [['content','Draft','content'],['resultContent','Draft','content'],['isRunning',true,'state'],['detail','Preparing','detail']]){
 globalThis.probe.expectedKey=`result.${field}`;trace.length=0;assert.equal(await callable(name)(context,record),expected);assert.deepEqual(trace,[['delivery',`result.${field}`],['read',field]]);
}
// A delivery leaf lowers through `?? null`; equality must compare its value,
// including reversed operands and inequality, without another observation.
for(const state of [null,'queued','running']){
 globalThis.probe.result={get state(){trace.push(['read','state']);return state;}};
 globalThis.probe.expectedKey='result.state';
 for(const [name,expected]of [['stateMissing',state===null],['statePresent',state!==null],['missingStateReverse',state===null],['presentStateReverse',state!==null]]){
  trace.length=0;assert.equal(await callable(name)(context,record),expected,`${name}: ${state}`);assert.deepEqual(trace,[['delivery','result.state'],['read','state']]);
 }
 trace.length=0;assert.equal(await callable('progressCaption')(context,{job:record}),state??'Missing');assert.deepEqual(trace,[['delivery','result.state'],['read','state']]);
}
globalThis.probe.result=null;globalThis.probe.expectedKey='result.content';trace.length=0;assert.equal(await callable('content')(context,record),'');assert.deepEqual(trace,[['delivery','result.content']]);
globalThis.probe.expectedKey='result.state';assert.equal(await callable('isRunning')(context,record),false);globalThis.probe.expectedKey='result.detail';assert.equal(await callable('detail')(context,record),'');
globalThis.probe.absentAssociation=true;
for(const [name,expected,field]of [['content','','content'],['resultContent','','content'],['isRunning',false,'state'],['detail','','detail']]){
 globalThis.probe.expectedKey=`result.${field}`;trace.length=0;assert.equal(await callable(name)(context,record),expected);assert.deepEqual(trace,[['delivery',`result.${field}`]]);
}
globalThis.probe.absentAssociation=false;
trace.length=0;assert.equal(await callable('ordinary')(context,{progress:'ordinary'}),'ordinary');assert.deepEqual(trace,[]);
globalThis.probe.result=result;globalThis.probe.grants=child;globalThis.probe.paths=new Set(grants[1].fields);globalThis.probe.expectedKey='result.content';assert.equal(await callable('content')(context,record),'Draft');assert.equal(await callable('resultContent')(context,record),'Draft');
const {delivery}=await import('@canlang/stdlib');globalThis.probe.expectedKey='result';await assert.rejects(delivery(context,{record,field:'request'},['result']),{message:'denied'});
globalThis.probe.grants=whole;globalThis.probe.paths=new Set(grants[0].fields);globalThis.probe.expectedKey='result.content';context.memberships=[];await assert.rejects(callable('content')(context,record),{message:'denied'});
console.log('declared progress alias: canonical grants, existing result selection, typed children/null/order and unrelated field passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
