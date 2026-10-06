//! C01 production boundary: the real CLI emits supported source against
//! the producer catalog. Node imports unmodified emitted modules and
//! evaluates defaults, message metadata and BDD closures through public
//! testkit loading/setup/observation APIs. This does not run operations.
//! Missing built packages/Node skip loudly, never substitute fixtures.

#[cfg(unix)]
#[test]
fn c01_production_strings_execute_through_testkit() {
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for relative in [
        "packages/values/dist/catalog.json",
        "node_modules/@canlang/stdlib/dist/src/index.js",
        "node_modules/@canlang/ui/dist/src/index.js",
        "node_modules/@canlang/testkit/dist/index.js",
    ] {
        if !root.join(relative).exists() {
            eprintln!("SKIP c01_production_strings_execute_through_testkit: missing {relative}");
            return;
        }
    }
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("SKIP c01_production_strings_execute_through_testkit: Node unavailable");
        return;
    }
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "can-c01-runtime-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )));
    std::fs::create_dir_all(&scratch.0).unwrap();
    std::os::unix::fs::symlink(root.join("node_modules"), scratch.0.join("node_modules")).unwrap();
    let runner = scratch.0.join("check.mjs");
    std::fs::write(&runner, r#"
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadExampleSuite, stashedRowOf } from "@canlang/testkit";

// Independently specified Unicode scalar values, not a decoder oracle.
const witnesses = [[8,12,128512], [233], [34,47,92], [233,128512], [10,13,9], []];
const expected = witnesses[Number(process.argv[3])];
const check = (value) => {
  assert.equal(typeof value, "string");
  assert.deepEqual(Array.from(value, ch => ch.codePointAt(0)), expected);
};
const artifactPath = process.argv[2];
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
assert.equal(artifact.artifact_version, 1);
assert.equal(artifact.tests.length, 0);
const examplesPath = process.argv[4];
const examples = JSON.parse(readFileSync(examplesPath, "utf8"));
assert.equal(examples.tests.length, 1);
const url = (module, base = artifactPath) => pathToFileURL(resolve(dirname(base), module.path)).href;
for (const [base, modules] of [[artifactPath, artifact.modules], [examplesPath, [...examples.modules, ...examples.tests.map(test => test.module)]]]) {
 for (const module of modules) {
  const path = resolve(dirname(base), module.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, module.js);
 }
}
const entry = await import(url(artifact.modules[0]));
const field = entry.appDefinition.models["Shop.Gadget"].fields.title;
check(field.default);
check(field.label.source);
check(field.label.variants.nl);
assert.equal(field.label.variants.fr, null);
check(artifact.models[0].fields.find(field => field.name === "title").default.value);
const suite = await loadExampleSuite(url(examples.tests[0].module, examplesPath), { self: null, other: null, imported: null });
assert.equal(suite.rows.length, 1);
const scope = { snapshot: async () => null, dispose: async () => {} };
const row = suite.rows[0];
await row.setup(scope, { self: "self", other: "other", outsider: "outsider", users: {} });
const stash = stashedRowOf(scope);
check(stash.inputs.value);
assert.equal(stash.cells.length, 1);
check(stash.cells[0]);
assert.equal(stash.expectedValues.length, 1);
check(stash.expectedValues[0]);
const observations = await row.observe(scope);
assert.equal(observations.length, 1);
check(observations[0]);
console.log(`C01 witness ${process.argv[3]}: production CLI, runtime metadata, testkit closures passed`);
"#).unwrap();

    for (index, token) in [
        r#""\b\f\uD83D\uDE00""#,
        r#""\u00E9""#,
        r#""\"\/\\""#,
        "\"é😀\"",
        r#""\n\r\t""#,
        "\"\"",
    ]
    .into_iter()
    .enumerate()
    {
        let dir = scratch.0.join(index.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let compile = |name: &str, text: String| {
            let output = dir.join(name);
            std::fs::create_dir_all(&output).unwrap();
            let source = output.join("strings.can");
            std::fs::write(&source, text).unwrap();
            let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
                .args(["compile", "--format=json", "--catalog"])
                .arg(root.join("packages/values/dist/catalog.json"))
                .arg(&source)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                compiled.status.success(),
                "{token}: CLI failed: {}\n{}",
                String::from_utf8_lossy(&compiled.stdout),
                String::from_utf8_lossy(&compiled.stderr)
            );
            let artifact = output.join("artifact.json");
            std::fs::write(&artifact, compiled.stdout).unwrap();
            artifact
        };
        // Metadata-only entry needs the actual UI message factory. The
        // separate BDD module is self-contained by the compiler contract;
        // its operation module is not imported or executed by this check.
        let artifact = compile(
            "metadata",
            format!(
                "app Shop\nGiven\n Gadget {{ title:text={token} desc={token} label={token}@{{nl={token},fr=null}} }}\nWhen\nThen\n"
            ),
        );
        let examples = compile(
            "examples",
            format!(
                "app Shop\nGiven\nWhen\n scenario echo(value:text) read=true -> text by=members\n  do\n   return value\n  examples value=\"\"\n   value -> {token}\n   {token} -> {token}\nThen\n"
            ),
        );
        let executed = Command::new("node")
            .arg(&runner)
            .arg(&artifact)
            .arg(index.to_string())
            .arg(&examples)
            .output()
            .unwrap();
        assert!(
            executed.status.success(),
            "{token}: Node failed: {}\n{}",
            String::from_utf8_lossy(&executed.stdout),
            String::from_utf8_lossy(&executed.stderr)
        );
        eprint!("{}", String::from_utf8_lossy(&executed.stdout));
    }
}
