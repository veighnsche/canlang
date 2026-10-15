//! Checked example callers retain canonical role identities through arrays.
use std::{path::PathBuf, process::Command};

const SOURCE: &str = "package First\n Given\n  export role reader\n When\n Then\npackage Second\n Given\n  export role reader\n When\n Then\napp RoleArrays\nuse First {reader as read_a}\nuse Second {reader as read_b}\nGiven\n role writer\nWhen\n scenario inspect() -> bool by=members\n  do return true\n  examples\n   as -> true\n   [writer,read_a,read_b] -> true\n   [members,read_a] -> true\n   [owner,read_b] -> true\nThen\n";

#[test]
fn checked_role_array_callers_publish_canonical_roles_and_refuse_invalid_members() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("roles.can");
    let compile = |text: &str| {
        std::fs::write(&source, text).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&source)
            .output()
            .unwrap()
    };
    let output = compile(SOURCE);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let suite = artifact["tests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|suite| suite["scope"] == "RoleArrays.inspect")
        .unwrap();
    let module = scratch.path().join("roles.mjs");
    std::fs::write(&module, suite["module"]["js"].as_str().unwrap()).unwrap();
    let check = scratch.path().join("check.mjs");
    std::fs::write(&check, "import assert from 'node:assert/strict';\nimport {exampleFixtures} from './roles.mjs';\nconst c={self:{id:'same-self'},other:{id:'other'},outsider:{id:'outsider'},imported:{}};\nconst table=exampleFixtures(c).examples[0];\nassert.deepEqual(await table.rows[0].values(c,{}),[['RoleArrays.writer','First.reader','Second.reader']]);\nassert.deepEqual(await table.rows[1].values(c,{}),[['members','First.reader']]);\nassert.deepEqual(await table.rows[2].values(c,{}),[['owner','Second.reader']]);\nassert.equal(c.self.id,'same-self');\n").unwrap();
    use std::io::Write;
    let mut runner = std::fs::OpenOptions::new()
        .append(true)
        .open(&check)
        .unwrap();
    writeln!(runner, "import {{createRequire}} from 'node:module'; import {{pathToFileURL}} from 'node:url'; const require=createRequire({}); const {{resolveCaller}}=await import(pathToFileURL(require.resolve('@canlang/testkit')).href); const roles=(await table.rows[0].values(c,{{}}))[0]; const caller=resolveCaller({{kind:'membership',roles}},{{self:c.self,other:c.other,outsider:c.outsider,users:{{}}}}); assert.strictEqual(caller.account,c.self); assert.equal(caller.team,'current'); assert.equal(caller.authenticated,true); assert.deepEqual(caller.roles,roles);", serde_json::to_string(&root.join("package.json").to_string_lossy()).unwrap()).unwrap();
    let result = Command::new("node").arg(check).output().unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    for invalid in [
        "self",
        "public",
        "authenticated",
        "\"First.reader\"",
        "[read_a]",
    ] {
        let text = SOURCE.replace("[writer,read_a,read_b]", &format!("[writer,{invalid}]"));
        let output = compile(&text);
        assert!(!output.status.success(), "invalid caller {invalid}");
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E5004"),
            "{invalid}: {report}"
        );
    }
}
