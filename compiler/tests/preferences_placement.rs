//! Configuration schemas live in Then, with their existing native behavior.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn then_preferences_preserve_defaults_validation_and_page_references() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/preferences-then.can");
    let input = scratch.path().join("preferences.can");
    std::fs::write(&input, source).unwrap();
    let compile = |path: &Path| {
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let output = compile(&input);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        artifact
            .get("diagnostics")
            .is_none_or(|value| value.as_array().unwrap().is_empty())
    );
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    for module in artifact["modules"].as_array().unwrap() {
        let path = scratch.path().join(module["path"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, module["js"].as_str().unwrap()).unwrap();
    }
    let runner = scratch.path().join("preferences.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {appDefinition,canApp}=await import(pathToFileURL(process.argv[2]));
const schema=appDefinition.preferences.Settings,registry=canApp();
assert.equal(schema.fields.view.default,'all');
assert.equal(schema.fields.limit.default,3n);
assert.equal(typeof registry[schema.validate],'function');
assert.equal(await registry[schema.validate]({actor:null},{view:'all',limit:3n}),true);
assert.equal(await registry[schema.validate]({actor:null},{view:'all',limit:0n}),false);
const page=appDefinition.pages.find(page=>page.path==='/settings');
const bindings=await page.admit({},{});
assert.deepEqual(bindings.preferences.Settings,{view:'all',limit:3n});
assert.match(await page.render({},bindings),/all/);
console.log('Then preferences: native defaults, validation and page references preserved');
"#,
    )
    .unwrap();
    let executed = Command::new("node")
        .arg(&runner)
        .arg(
            scratch
                .path()
                .join(artifact["modules"][0]["path"].as_str().unwrap()),
        )
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));

    for (name, rejected, message) in [
        (
            "given-schema",
            "app Settings\nGiven\n preferences {view:text=\"all\"}\nWhen\nThen\n",
            "preferences schemas belong in Then",
        ),
        (
            "given-validation",
            "app Settings\nGiven\n invariant preferences: row.limit>0\nWhen\nThen\n preferences {limit:int=3}\n",
            "preferences validation belongs in Then",
        ),
        (
            "then-model-validation",
            "app Settings\nGiven\n preferences in app {limit:int=3}\n policy preferences read=members\nWhen\nThen\n invariant preferences: row.limit>0\n",
            "Then invariants must validate the owning preferences schema",
        ),
    ] {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, rejected).unwrap();
        let refused = compile(&path);
        assert_eq!(
            refused.status.code(),
            Some(10),
            "{name}: {}",
            String::from_utf8_lossy(&refused.stdout)
        );
        let artifact: serde_json::Value = serde_json::from_slice(&refused.stdout).unwrap();
        assert!(
            artifact["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diag| diag["code"] == "E1200"
                    && diag["message"].as_str().unwrap().contains(message)),
            "{name}: {artifact}"
        );
        assert!(
            artifact.get("modules").is_none(),
            "{name}: no publication on placement error"
        );
    }
    // A fact model with this contextual name retains ordinary Given rules.
    let path = scratch.path().join("named-model.can");
    std::fs::write(&path, "app Settings\nGiven\n preferences in app {limit:int=3}\n policy preferences read=members\n invariant preferences: row.limit>0\nWhen\nThen\n").unwrap();
    let model = compile(&path);
    assert!(
        model.status.success(),
        "{}",
        String::from_utf8_lossy(&model.stdout)
    );
}
