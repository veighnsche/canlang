//! Checked contextual actor facts through production artifacts and public owners.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn compile(dir: &Path, source: &str) -> (std::process::Output, serde_json::Value) {
    let path = dir.join("facts.can");
    std::fs::write(&path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let result = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)));
    (output, result)
}

#[test]
fn contextual_facts_read_separate_carrier_and_user_refs_stay_closed() {
    let scratch = tempfile::tempdir().unwrap();
    let source = "app Facts\nGiven\n contract Info { email:email, email_verified:bool }\n contract Box { actor:Info }\nWhen\n scenario email() read=true -> email by=authenticated\n  do return actor.email\n scenario groupedEmail() read=true -> email by=authenticated\n  do return ((actor)).email\n scenario verified() read=true -> bool by=authenticated\n  do return actor.email_verified\n scenario groupedVerified() read=true -> bool by=authenticated\n  do return (actor).email_verified\n scenario identity() read=true -> user by=authenticated\n  do return actor\n scenario objectEmail(c:Box) read=true -> email by=authenticated\n  do return (c.actor).email\n scenario objectVerified(c:Box) read=true -> bool by=authenticated\n  do return (c.actor).email_verified\nThen\n";
    let (output, artifact) = compile(scratch.path(), source);
    assert!(output.status.success(), "{artifact}");
    let emitted = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        emitted.contains("c.actorFacts.email"),
        "{emitted}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(emitted.contains("c.actorFacts.email_verified"), "{emitted}");
    assert!(!emitted.contains("c.actor.email"), "{emitted}");
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    std::fs::write(scratch.path().join("artifact.json"), &output.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const artifact=JSON.parse(readFileSync(new URL('./artifact.json',import.meta.url),'utf8'));
const dir=dirname(new URL(import.meta.url).pathname);
for(const module of artifact.modules){const path=resolve(dir,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(dir,artifact.modules[0].path)));
const registry=entry.canApp();
function callable(name){const desc=artifact.callables.find(item=>item.id===`Facts.${name}`);assert(desc,name);let fn=registry;for(const part of desc.member)fn=fn[part];assert.equal(typeof fn,'function');return fn;}
const actor=Object.freeze({kind:'user',id:'user-1'});
for(const [email,verified] of [['first@example.test',true],['fresh@example.test',false]]){
 const context=Object.freeze({actor,actorFacts:Object.freeze({email,email_verified:verified}),memberships:['authenticated']});
 for(const name of ['email','groupedEmail'])assert.equal(await callable(name)(context,{}),email);
 for(const name of ['verified','groupedVerified'])assert.equal(await callable(name)(context,{}),verified);
 assert.equal(await callable('identity')(context,{}),actor);
 assert.deepEqual(Object.keys(actor),['kind','id']);
 const c=Object.freeze({actor:Object.freeze({email:'object@example.test',email_verified:!verified})});
 assert.equal(await callable('objectEmail')(context,{c}),'object@example.test');
 assert.equal(await callable('objectVerified')(context,{c}),!verified);
}
await assert.rejects(()=>callable('email')({actor:null,actorFacts:null,memberships:[]},{}));
"#).unwrap();
    let executed = Command::new("node").arg(runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );

    for field in ["email", "email_verified"] {
        for body in [
            format!("let alias=actor\n   require alias!=null\n   let value=alias.{field}"),
            format!("let value=person.{field}"),
        ] {
            let source = format!(
                "app Facts\nGiven\nWhen\n scenario s(person:user) by=authenticated\n  do\n   {body}\nThen\n"
            );
            let (output, result) = compile(scratch.path(), &source);
            assert!(!output.status.success(), "{field}: {result}");
            assert!(
                result["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == "E2013"),
                "{result}"
            );
            assert!(result.get("modules").is_none(), "{result}");
        }
        let source = format!(
            "app Facts\nGiven\n M {{ title:text }}\nWhen\n scenario h on=M.create\n  do\n   require actor!=null\n   let value=actor.{field}\nThen\n"
        );
        let (output, result) = compile(scratch.path(), &source);
        assert!(!output.status.success(), "{field}: {result}");
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E3003"),
            "{result}"
        );
        assert!(result.get("modules").is_none(), "{result}");
    }
    let source = "app Facts\nGiven\n M { title:text }\nWhen\n scenario h on=M.create\n  do\n   let value=actor\nThen\n";
    let (output, result) = compile(scratch.path(), source);
    assert!(!output.status.success(), "{result}");
    assert!(
        result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"
                && diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("hook contextual binding `actor`")),
        "{result}"
    );
    assert!(result.get("modules").is_none(), "{result}");
}
