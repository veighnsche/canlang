//! Exact Decimal construction from legal checked source through installed public owners.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/decimal-runtime/source.can");

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn compile(dir: &Path, name: &str, source: &str) -> std::process::Output {
    let input = dir.join(format!("{name}.can"));
    std::fs::write(&input, source).unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(input)
        .current_dir(root())
        .output()
        .unwrap()
}

#[test]
fn checked_decimal_materialization_and_default_consumers() {
    for path in [
        "packages/values/dist/catalog.json",
        "node_modules/@canlang/stdlib/dist/src/index.js",
    ] {
        assert!(
            root().join(path).exists(),
            "real built owner required: {path}"
        );
    }
    let scratch = tempfile::Builder::new()
        .prefix("can-decimal-")
        .tempdir()
        .unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let output = compile(scratch.path(), "exact", SOURCE);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), &output.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        include_str!("fixtures/decimal-runtime/execute.mjs"),
    )
    .unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}

#[test]
fn decimal_range_refusals_and_action_target_construction() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, expression, diagnostic) in [
        ("scale19", "1.0000000000000000000", "E3001"),
        (
            "digits39",
            "999999999999999999999.123456789012345678",
            "E3001",
        ),
        ("plus", "+1.50", "E1215"),
    ] {
        let output = compile(
            scratch.path(),
            name,
            &format!("app T\nGiven\n derive value():decimal = {expression}\nWhen\nThen\n"),
        );
        assert!(!output.status.success(), "{name} unexpectedly compiled");
        let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            json["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == diagnostic),
            "{name}: {json}"
        );
    }
    let output = compile(
        scratch.path(),
        "action",
        "app T\nGiven\nWhen\n scenario mutate(value:decimal=1.50) by=members\n  do\n   let x = value\n scenario descriptor() read=true -> action(mutate) by=members\n  do\n   return action(mutate,{})\nThen\n",
    );
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(json.get("diagnostics").is_none(), "{json}");
}

#[test]
fn isolated_decimal_helpers_pin_their_family_through_real_artifact_compatibility() {
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(root().join("node_modules"), scratch.path().join("node_modules")).unwrap();
    let helpers = [
        ("parseDecimal", "decimal", "1.5"),
        ("addDecimal", "decimal", "a+b"),
        ("subtractDecimal", "decimal", "a-b"),
        ("multiplyDecimal", "decimal", "a*b"),
        ("divideDecimal", "decimal", "a/b"),
        ("negateDecimal", "decimal", "-a"),
        ("compareDecimal", "bool", "a<b"),
    ];
    let mut artifacts = Vec::new();
    for (helper, result, expression) in helpers {
        let source = format!("app DecimalRequirement\nGiven\n derive value(a:decimal,b:decimal):{result} = {expression}\nWhen\nThen\n");
        let output = compile(scratch.path(), helper, &source);
        assert!(output.status.success(), "{helper}: {}", String::from_utf8_lossy(&output.stdout));
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let js = artifact["modules"][0]["js"].as_str().unwrap();
        assert!(js.contains(helper), "{helper}: {js}");
        for (other, _, _) in helpers {
            if other != helper {
                assert!(!js.contains(other), "{helper} must not acquire its requirement through {other}");
            }
        }
        let requires = artifact["requires"].as_array().unwrap();
        assert_eq!(requires.iter().filter(|r| r["capability"] == "values.decimal").count(), 1);
        assert!(requires.iter().any(|r| r["capability"] == "values.decimal" && r["min_version"] == 1));
        assert!(requires.iter().any(|r| r["capability"] == "canlang.builtins"));
        artifacts.push(artifact);
    }
    let plain = compile(scratch.path(), "plain", "app Plain\nGiven\n derive value():bool = true\nWhen\nThen\n");
    assert!(plain.status.success(), "{}", String::from_utf8_lossy(&plain.stdout));
    let plain: serde_json::Value = serde_json::from_slice(&plain.stdout).unwrap();
    assert!(!plain["requires"].as_array().unwrap().iter().any(|r| r["capability"] == "values.decimal"));
    std::fs::write(scratch.path().join("artifacts.json"), serde_json::to_vec(&artifacts).unwrap()).unwrap();
    let runner = scratch.path().join("compatibility.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseArtifactText} from '@canlang/cloudflare/runtime/artifact';
import {checkCompatibility} from '@canlang/cloudflare/deploy/compat';
for(const artifact of JSON.parse(readFileSync(new URL('./artifacts.json',import.meta.url),'utf8'))){
 const loaded=parseArtifactText(JSON.stringify(artifact),'decimal.can');
 assert.deepEqual(loaded.artifact.requires,artifact.requires);
 const requiredCapabilities=artifact.requires.map(value=>value.capability);
 const descriptor={identity:{contractsVersion:1,languageVersion:artifact.language_version},
  requiredCapabilities,resourceBindings:[],secrets:[],schedules:[]};
 const environment={resources:[],secretsPresent:[]};
 const installed={contractsVersion:1,runtimeVersion:'test',knownLanguageVersions:[artifact.language_version],
  capabilities:requiredCapabilities,supportsSchedules:false};
 assert.deepEqual(checkCompatibility(descriptor,environment,installed),{compatible:true});
 assert.deepEqual(checkCompatibility(descriptor,environment,{...installed,
  capabilities:requiredCapabilities.filter(value=>value!=='values.decimal')}),
  {compatible:false,reasons:[{code:'missing-capability',detail:'values.decimal'}]});
}
"#).unwrap();
    let executed = Command::new("node").arg(runner).current_dir(scratch.path()).output().unwrap();
    assert!(executed.status.success(), "{}\n{}", String::from_utf8_lossy(&executed.stdout), String::from_utf8_lossy(&executed.stderr));
}
