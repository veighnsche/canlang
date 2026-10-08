//! Actual compiled Money defaults agree with the owning public Values API.
#[cfg(unix)]
#[test]
fn money_constructor_defaults_follow_owning_values() {
    use serde_json::{Value, json};
    use std::path::Path;
    use std::process::Command;

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let cases = [
        ("fraction", "money(0.20,\"EUR\")", "0.20", "EUR", "20"),
        ("integer", "money(2,\"EUR\")", "2", "EUR", "200"),
        ("even", "money(1.005,\"EUR\")", "1.005", "EUR", "100"),
        ("odd", "money(1.015,\"EUR\")", "1.015", "EUR", "102"),
        ("negative", "money(-1.005,\"EUR\")", "-1.005", "EUR", "-100"),
        ("jpy", "money(1.5,\"JPY\")", "1.5", "JPY", "2"),
        ("jpyEven", "money(2.5,\"JPY\")", "2.5", "JPY", "2"),
        ("kwd", "money(1.2345,\"KWD\")", "1.2345", "KWD", "1234"),
        ("kwdOdd", "money(1.2355,\"KWD\")", "1.2355", "KWD", "1236"),
        (
            "maximum",
            "money(92233720368547758.07,\"EUR\")",
            "92233720368547758.07",
            "EUR",
            "9223372036854775807",
        ),
        (
            "minimum",
            "money(-92233720368547758.08,\"EUR\")",
            "-92233720368547758.08",
            "EUR",
            "-9223372036854775808",
        ),
        (
            "named",
            "money(currency=\"EUR\",value=0.10)",
            "0.10",
            "EUR",
            "10",
        ),
    ];
    let fields = cases
        .iter()
        .map(|(name, expression, ..)| format!("{name}:money={expression}"))
        .chain([
            "optional:money?=money(0.20,\"EUR\")".to_string(),
            "coins:money[]=[money(0.10,\"EUR\"),money(-1.015,\"EUR\")]".to_string(),
            "maybeCoins:money[]?=[money(0.10,\"EUR\")]".to_string(),
            "none:money?=null".to_string(),
            "empty:money[]=[]".to_string(),
        ])
        .collect::<Vec<_>>()
        .join(",");
    let mut source = format!("app Cash\nGiven\n Ledger {{{fields}}}\nWhen\n");
    for (name, expression, ..) in cases {
        source.push_str(&format!(" scenario {name}(value:money={expression}) read=true -> money by=members\n  do return value\n"));
    }
    for (name, ty, expression) in [
        ("optional", "money?", "money(0.20,\"EUR\")"),
        (
            "coins",
            "money[]",
            "[money(0.10,\"EUR\"),money(-1.015,\"EUR\")]",
        ),
        ("maybeCoins", "money[]?", "[money(0.10,\"EUR\")]"),
        ("none", "money?", "null"),
        ("empty", "money[]", "[]"),
    ] {
        source.push_str(&format!(" scenario {name}(value:{ty}={expression}) read=true -> {ty} by=members\n  do return value\n"));
    }
    source.push_str("Then\n");
    let path = scratch.path().join("defaults.can");
    std::fs::write(&path, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    let model = artifact["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["name"] == "Cash.Ledger")
        .unwrap();
    for (name, _, _, currency, minor) in cases {
        let field = model["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["name"] == name)
            .unwrap();
        assert_eq!(
            field["default"],
            json!({"kind":"literal","value":{"minor":minor,"currency":currency}}),
            "{name}"
        );
        let op = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == format!("Cash.{name}"))
            .unwrap();
        assert_eq!(
            op["inputs"]["fields"][0]["default"], field["default"],
            "{name}"
        );
    }
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();
    std::fs::write(
        scratch.path().join("cases.json"),
        serde_json::to_vec(&cases).unwrap(),
    )
    .unwrap();
    let runner = scratch.path().join("defaults.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {money,parseDecimal,encodeValue,decodeValue} from '@canlang/values';
const base=dirname(fileURLToPath(import.meta.url));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path)).href);
const fields=entry.appDefinition.models['Cash.Ledger'].fields;
const model=artifact.models.find(model=>model.name==='Cash.Ledger');
const expected=new Map();
for(const [name,,amount,currency,minor] of JSON.parse(readFileSync(resolve(base,'cases.json'),'utf8'))){
 const owned=money(parseDecimal(amount),currency);
 assert.equal(owned.minor,BigInt(minor),name);
 expected.set(name,['money',owned]);
}
expected.set('optional',['money?',money(parseDecimal('0.20'),'EUR')]);
expected.set('coins',['money[]',[money(parseDecimal('0.10'),'EUR'),money(parseDecimal('-1.015'),'EUR')]]);
expected.set('maybeCoins',['money[]?',[money(parseDecimal('0.10'),'EUR')]]);
expected.set('none',['money?',null]);expected.set('empty',['money[]',[]]);
for(const [name,[type,owned]] of expected){
 const modelDefault=model.fields.find(field=>field.name===name).default;
 const input=artifact.operations.find(op=>op.name===`Cash.${name}`).inputs.fields[0];
 const nativeParam=entry.appDefinition.operations[`Cash.${name}`].inputs.value.default;
 assert.equal(modelDefault.kind,'literal',name);assert.equal(input.default.kind,'literal',name);
 assert.deepEqual(modelDefault.value,encodeValue(type,owned),name);
 assert.deepEqual(input.default.value,modelDefault.value,name);
 assert.deepEqual(fields[name].default,owned,name);
 assert.deepEqual(nativeParam,owned,name);
 assert.deepEqual(decodeValue(type,modelDefault.value),owned,name);
 assert.equal(input.required,false,name);
}
console.log('Compiled scalar, nullable and array Money defaults match public Values construction and codecs');
"#).unwrap();
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
}
