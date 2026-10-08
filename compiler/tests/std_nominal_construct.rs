//! Consumed std nominal schemas contextualize constructs without guessing external types.
use std::{path::Path, process::Command};

const SOURCE: &str = r#"app TypedGenerationProgress
use std {TextMessage,TextRequest}
use std {TextGenerationV1 as LLM} from=deployment.llm
Given
 Job { label:text="Generation", request:delivery(LLM.generate)? }
 ## Progress is visible only through the current member grant.
 policy Job read=members fields=label,request.status,request.result
When
 crud Job by=members fields=label
 ## Freeze correlation and budgets in the source-owned request before staging.
 scenario generate(job:Job,prompt:text,accept:bool) by=members
  do
   let value=TextRequest {source=operation.id,revision=job.version,profile="local-chat",policy_revision="policy-1",messages=[TextMessage {role=user,content=prompt,attachments=[]}],max_input_tokens=1024,max_output_tokens=128,max_duration=30s}
   send LLM.generate {value} as attempt
   set job {request=attempt}
   require accept
Then
"#;

#[test]
fn std_nominal_constructs_check_fields_and_execute_contextual_enum_cases() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let run = |command: &str, source: &str| {
        let input = scratch.path().join("nominals.can");
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let checked = run("check", SOURCE);
    assert!(
        checked.status.success(),
        "{}",
        String::from_utf8_lossy(&checked.stdout)
    );
    let compiled = run("compile", SOURCE);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    std::fs::create_dir_all(scratch.path().join("node_modules/@canlang/stdlib")).unwrap();
    std::fs::write(
        scratch
            .path()
            .join("node_modules/@canlang/stdlib/package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        scratch
            .path()
            .join("node_modules/@canlang/stdlib/index.mjs"),
        r#"
import assert from 'node:assert/strict';
export function hasRole(context,role){assert.equal(context,globalThis.probe.context);return context.memberships.includes(role);}
function check(value){globalThis.probe.trace.push(['check',value]);if(!value)throw Error('authored refusal');}
export {check as require};
export async function send(context,operation,request,options){
 const probe=globalThis.probe;assert.equal(context,probe.context);assert.equal(operation,'std.TextGenerationV1.generate');assert.deepEqual(options,{binding:'TypedGenerationProgress.LLM'});
 assert.deepEqual(request,{value:{source:'origin-1',revision:3n,profile:'local-chat',policy_revision:'policy-1',messages:[{role:'user',content:probe.prompt,attachments:[]}],max_input_tokens:1024n,max_output_tokens:128n,max_duration:30000n}});
 probe.trace.push(['send']);return probe.attempt;
}
export async function set(context,record,changes){const probe=globalThis.probe;assert.equal(context,probe.context);assert.equal(record,probe.record);assert.equal(changes.request,probe.attempt);probe.trace.push(['set']);}
export async function create(){throw Error('unexpected create');}
export async function deleteRecord(){throw Error('unexpected delete');}
"#,
    )
    .unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const descriptor=artifact.callables.find(item=>item.id==='TypedGenerationProgress.generate');assert(descriptor);
const module=await import(pathToFileURL(resolve(base,descriptor.module)));let callable=module.canApp();for(const part of descriptor.member)callable=callable[part];
assert.deepEqual(module.appDefinition.bindings['TypedGenerationProgress.LLM'],{capability:'std.TextGenerationV1',from:'deployment.llm'});
const context={operation:{id:'origin-1'},memberships:['members']},record={id:'job-1',version:3n},attempt={id:'attempt-1',operation:'std.TextGenerationV1.generate'},trace=[];
for(const prompt of ['Authored prompt','']){
 globalThis.probe={context,record,attempt,trace,prompt};
 trace.length=0;await callable(context,{job:record,prompt,accept:true});assert.deepEqual(trace,[['check',true],['send'],['set'],['check',true]]);
 trace.length=0;await assert.rejects(callable(context,{job:record,prompt,accept:false}),{message:'authored refusal'});assert.deepEqual(trace,[['check',true],['send'],['set'],['check',false]]);
}

"#).unwrap();
    let native = Command::new("node").arg(runner).output().unwrap();
    assert!(
        native.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&native.stdout),
        String::from_utf8_lossy(&native.stderr)
    );

    for (source, code, detail) in [
        (
            SOURCE.replace("role=user", "role=visitor"),
            "E2001",
            "visitor",
        ),
        (
            SOURCE.replace("role=user,content=prompt", "role=user"),
            "E3001",
            "missing required field 'content'",
        ),
        (
            SOURCE.replace("role=user", "extra=1,role=user"),
            "E2013",
            "extra",
        ),
        (
            SOURCE.replace("content=prompt", "content=1"),
            "E3001",
            "field 'content'",
        ),
        (
            SOURCE.replace("accept:bool", "accept:bool,user:int=1"),
            "E3001",
            "field 'role'",
        ),
    ] {
        let checked = run("check", &source);
        assert!(!checked.status.success(), "{source}");
        let result: serde_json::Value = serde_json::from_slice(&checked.stdout).unwrap();
        let diagnostics = result["diagnostics"].as_array().unwrap();
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic["code"] == code
                    && diagnostic["message"].as_str().unwrap().contains(detail)),
            "{result}"
        );
    }
    let alias = SOURCE
        .replace(
            "use std {TextMessage,TextRequest}",
            "use std {TextMessage as Message,TextRequest} from=deployment.nominals",
        )
        .replace("TextMessage {", "Message {");
    let checked = run("check", &alias);
    assert!(
        checked.status.success(),
        "{}",
        String::from_utf8_lossy(&checked.stdout)
    );
    // Unknown bound providers and unknown std names retain their opaque behavior.
    for import in [
        "use elsewhere {TextMessage as Message} from=deployment.external",
        "use std {FutureMessage as Message} from=deployment.external",
    ] {
        let source = format!(
            "app Opaque\n{import}\nGiven\n derive untouched():text=\"ok\"\nWhen\n scenario authored() by=public\n  do\n   let value=Message {{foreign=\"field\"}}\nThen\n"
        );
        let checked = run("check", &source);
        assert!(
            checked.status.success(),
            "{}",
            String::from_utf8_lossy(&checked.stdout)
        );
    }
}
