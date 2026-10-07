//! Fresh CLI output consumed unchanged by the actual Cloudflare text/file loaders.
//! Built producer packages and Node are prerequisites; absence skips explicitly.
#[test]
fn fresh_cli_artifact_loads_through_cloudflare() {
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for relative in [
        "packages/values/dist/catalog.json",
        "packages/cloudflare/dist/runtime/artifact.js",
    ] {
        if !root.join(relative).is_file() {
            eprintln!("SKIP fresh_cli_artifact_loads_through_cloudflare: missing {relative}");
            return;
        }
    }
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("SKIP fresh_cli_artifact_loads_through_cloudflare: Node unavailable");
        return;
    }
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "can-pass5-artifact-consumer-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
    )));
    std::fs::create_dir_all(&scratch.0).unwrap();
    let source = scratch.0.join("wire.can");
    // Integer magnitude, Unicode, controls and source identities are independently
    // asserted in Node. Decimal defaults remain blocked by production E6008;
    // their authored scale is covered by the separate artifact byte fixture.
    let text = "app Shop\nGiven\n Gadget { title:text=\"é😀\\b\\f\", stock:int=9223372036854775807, price:decimal, active:bool=true, nick:text? }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title,stock,price,active,nick\nThen\n";
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
        "CLI failed: {}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    assert!(compiled.stderr.is_empty());
    assert!(compiled.stdout.ends_with(b"}\n"));
    assert_eq!(
        compiled
            .stdout
            .iter()
            .filter(|byte| **byte == b'\n')
            .count(),
        1
    );
    let artifact = scratch.0.join("artifact.json");
    std::fs::write(&artifact, &compiled.stdout).unwrap();
    let runner = scratch.0.join("check.mjs");
    std::fs::write(&runner, r#"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const [loaderPath, artifactPath, sourcePath, languageVersion, toolVersion] = process.argv.slice(2);
const { parseArtifactText, loadArtifactFile, assertCompiledIdentity } = await import(pathToFileURL(loaderPath));
const bytes = readFileSync(sourcePath);
const text = readFileSync(artifactPath, "utf8");
const fromText = parseArtifactText(text, `compiled:${sourcePath}`);
const fromFile = loadArtifactFile(artifactPath);
assert.deepEqual(fromFile.artifact, fromText.artifact);
assert.equal(fromFile.sourcePath, artifactPath);
assert.equal(fromText.sourcePath, `compiled:${sourcePath}`);
const a = fromText.artifact;
assert.equal(a.artifact_version, 1);
assert.equal(a.language_version, languageVersion);
assert.equal(a.tool_version, toolVersion);
assert.equal(a.sources.length, 1);
assert.equal(a.sources[0].path, sourcePath);
assert.equal(a.sources[0].sha256, createHash("sha256").update(bytes).digest("hex"));
assertCompiledIdentity(a, { sourcePath, sourceSha256: createHash("sha256").update(bytes).digest("hex"), languageVersion, toolVersion });
assert.equal(a.models.length, 1);
const model = a.models[0];
assert.equal(model.name, "Shop.Gadget");
assert.equal(model.deleteMode, "archive");
assert.deepEqual(model.fields.map(field => field.name), ["title", "stock", "price", "active", "nick"]);
assert.deepEqual(model.fields.map(field => field.field.kind), ["string", "integer", "decimal", "boolean", "string"]);
assert.deepEqual(model.fields.map(field => field.default?.value), ["é😀\b\f", "9223372036854775807", undefined, true, undefined]);
assert.equal(model.fields[4].nullable, true);
assert.equal(Object.hasOwn(model.fields[4], "default"), false);
assert.ok(a.operations.some(operation => operation.name === "Shop.Gadget.create"));
const create = a.operations.find(operation => operation.name === "Shop.Gadget.create");
assert.equal(create.inputs.fields.find(field => field.name === "price").field.kind, "decimal");
assert.equal(Object.hasOwn(create.inputs.fields.find(field => field.name === "price"), "default"), false);
assert.ok(a.modules.length > 0);
for (const module of a.modules) {
 assert.equal(typeof module.js, "string");
 assert.equal(typeof module.map, "object");
 assert.equal(module.map.version, 3);
 assert.equal(module.map.file, module.path);
 assert.deepEqual(module.map.sources, [sourcePath]);
 assert.deepEqual(module.map.sourcesContent, [bytes.toString("utf8")]);
 assert.equal(typeof module.map.mappings, "string");
 assert.ok(module.map.mappings.length > 0);
}
console.log(JSON.stringify({consumer:"actual Cloudflare parseArtifactText + loadArtifactFile", models:a.models.length, operations:a.operations.length, sourceHash:a.sources[0].sha256, decimalType:"decimal", decimalScaleGate:"production decimal literal E6008; separate typed artifact fixture covers scale", maps:a.modules.length}));
"#).unwrap();
    let checked = Command::new("node")
        .arg(&runner)
        .arg(root.join("packages/cloudflare/dist/runtime/artifact.js"))
        .arg(&artifact)
        .arg(&source)
        .arg(canlang_compiler::LANGUAGE_VERSION)
        .arg(env!("CARGO_PKG_VERSION"))
        .output()
        .unwrap();
    assert!(
        checked.status.success(),
        "Cloudflare consumer failed: {}\n{}",
        String::from_utf8_lossy(&checked.stdout),
        String::from_utf8_lossy(&checked.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&checked.stdout));
    std::fs::write(
        std::env::temp_dir().join("canlang-pass5-artifact-consumer-evidence.json"),
        &checked.stdout,
    )
    .unwrap();
}
