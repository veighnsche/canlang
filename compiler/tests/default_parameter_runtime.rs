//! Signature defaults through the actual CLI and unchanged emitted callable ABI.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn derive_defaults_execute_in_order_and_scenario_defaults_remain_explicitly_refused() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let run_cli = |command: &str, name: &str, source: &str| {
        let input = scratch.path().join(name);
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let source = "app Defaults\nGiven\n derive chosen(seed:text=\"x\",copied:text=seed,finished:text=copied):text = finished\nWhen\nThen\n";
    let compiled = run_cli("compile", "defaults.can", source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const registries=new Map();
async function callable(id){
 const descriptor=artifact.callables.find(item=>item.id===id);assert(descriptor,id);
 if(!registries.has(descriptor.module)){const module=await import(pathToFileURL(resolve(base,descriptor.module)));registries.set(descriptor.module,module.canApp());}
 let fn=registries.get(descriptor.module);for(const part of descriptor.member)fn=fn[part];assert.equal(typeof fn,'function');return fn;
}
const chosen=await callable('Defaults.chosen');
const context={};
for(const [args,expected] of [
 [[], 'x'],
 [['supplied'], 'supplied'],
 [[undefined,'second'], 'second'],
 [['first','second'], 'second'],
 [['first','second','third'], 'third'],
 [[''], ''],
])assert.equal(await chosen(context,...args),expected);
console.log('actual derive defaults: omitted, supplied and left-to-right earlier references passed');
"#).unwrap();
    let executed = Command::new("node").arg(&runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );

    let scenario = "app Defaults\nGiven\nWhen\n scenario selected(seed:text=\"x\",copied:text=seed,finished:text=copied) read=true -> text by=public\n  do return finished\nThen\n";
    let unsupported = run_cli("compile", "scenario.can", scenario);
    assert_eq!(unsupported.status.code(), Some(10));
    let output =
        canlang_compiler::json::parse(&String::from_utf8_lossy(&unsupported.stdout)).unwrap();
    assert!(
        output.get("modules").is_none(),
        "refused compile emitted modules"
    );
    let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
    assert_eq!(diagnostics.len(), 2, "{diagnostics:?}");
    for diagnostic in diagnostics {
        assert_eq!(diagnostic.get("code").unwrap().as_str(), Some("E6008"));
        assert_eq!(
            diagnostic.get("message").unwrap().as_str(),
            Some(
                "cannot lower parameter default: computed parameter defaults have no §13 lowering"
            )
        );
    }

    let refused = "app Refused\nGiven\n derive self(seed:text=seed):text=seed\n derive later(seed:text=copied,copied:text=\"x\"):text=seed\nWhen\n scenario body(seed:text=inside) read=true -> text by=public\n  do\n   let inside=\"body\"\n   return seed\nThen\n";
    let checked = run_cli("check", "refused.can", refused);
    assert_eq!(checked.status.code(), Some(10));
    let output = canlang_compiler::json::parse(&String::from_utf8_lossy(&checked.stdout)).unwrap();
    let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
    assert_eq!(diagnostics.len(), 3, "{diagnostics:?}");
    for (diagnostic, expected) in diagnostics.iter().zip(["seed", "copied", "inside"]) {
        assert_eq!(diagnostic.get("code").unwrap().as_str(), Some("E2001"));
        assert_eq!(
            diagnostic.get("message").unwrap().as_str(),
            Some(format!("unresolved name '{expected}'").as_str())
        );
        let primary = diagnostic.get("primary").unwrap();
        let start = primary.get("start").unwrap().as_i64().unwrap() as usize;
        let end = primary.get("end").unwrap().as_i64().unwrap() as usize;
        assert_eq!(&refused[start..end], expected);
    }
}
