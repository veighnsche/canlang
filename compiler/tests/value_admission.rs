//! C03U production boundary: actual values exports and compiler-emitted
//! URL defaults retain authored text. This loads unmodified metadata JS
//! through the real UI package; it does not execute an application.
//! Missing built packages/catalog/Node skip loudly, without substitutes.

#[cfg(unix)]
#[test]
fn url_values_retain_authored_text_through_production_metadata() {
    use std::fs::{self, File};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for relative in [
        "packages/values/dist/catalog.json",
        "node_modules/@canlang/values/dist/src/index.js",
        "node_modules/@canlang/stdlib/dist/src/index.js",
        "node_modules/@canlang/ui/dist/src/index.js",
    ] {
        if !root.join(relative).exists() {
            eprintln!("SKIP URL production metadata: missing {relative}");
            return;
        }
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "can-url-value-admission-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )));
    fs::create_dir_all(&scratch.0).unwrap();
    std::os::unix::fs::symlink(root.join("node_modules"), scratch.0.join("node_modules")).unwrap();
    let runner = scratch.0.join("check.mjs");
    fs::write(
        &runner,
        r#"
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { decodeValue, encodeValue } from "@canlang/values";

const [root, compiler, scratch] = process.argv.slice(2);
const packet = resolve(root, "docs/research/compiler-library-audit-20261006/pass3/url");
const vectors = JSON.parse(readFileSync(resolve(packet, "vectors.json"), "utf8"));
assert.equal(vectors.length, 29, "independent URL qualification corpus");
assert.equal(new Set(vectors.map(test => test.id)).size, vectors.length);
for (const test of vectors) {
  assert.equal(typeof test.value, "string", test.id);
  assert.equal(typeof test.expected, "boolean", test.id);
}

// The saved probe exercises the actual package root: accepted decode,
// direct encode and roundtrip preserve raw text; invalid decode reports
// SchemaError/format, invalid encode reports ValueError/invalid-construction.
// It also contrasts ordinary userinfo with trusted app_url origins and
// checks canonical mount construction. No native URL serves as an oracle.
await import(pathToFileURL(resolve(packet, "public-probe.mjs")).href);

let retained = 0;
for (const test of vectors.filter(test => test.expected)) {
  const directory = resolve(scratch, test.id);
  mkdirSync(directory, { recursive: true });
  const source = resolve(directory, "value.can");
  writeFileSync(source, `app T\nGiven\n M { link:url=${JSON.stringify(test.value)} }\nWhen\nThen\n`);
  const compiled = spawnSync(compiler, ["compile", "--format=json", "--catalog",
    resolve(root, "packages/values/dist/catalog.json"), source], {
    cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(compiled.error);
  assert.equal(compiled.status, 0, `${test.id}: production compile failed\n${compiled.stdout}\n${compiled.stderr}`);
  // Successful production CLI emission goes through the completeness
  // gate. No test-only emission flag or synthetic catalog is supplied.
  const artifact = JSON.parse(compiled.stdout);
  assert.equal(artifact.artifact_version, 1, test.id);
  assert.ok(artifact.modules.length > 0, `${test.id}: no production module`);
  assert.equal(artifact.tests.length, 0, test.id);
  const model = artifact.models.find(model => model.name === "T.M");
  assert.ok(model, `${test.id}: missing model descriptor`);
  const field = model.fields.find(field => field.name === "link");
  assert.ok(field, `${test.id}: missing field descriptor`);
  assert.equal(field.default.value, test.value, `${test.id}: artifact literal default`);
  for (const module of artifact.modules) {
    const path = resolve(directory, module.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, module.js);
  }
  // Import the bytes emitted by the compiler, including its actual UI
  // imports. Verify the executed metadata value rather than JS spelling.
  const entry = await import(pathToFileURL(resolve(directory, artifact.modules[0].path)).href);
  const actual = entry.appDefinition.models["T.M"].fields.link.default;
  assert.equal(actual, test.value, `${test.id}: emitted metadata default`);
  assert.equal(decodeValue("url", actual), test.value, `${test.id}: default decode`);
  assert.equal(encodeValue("url", actual), test.value, `${test.id}: default encode`);
  assert.equal(encodeValue("url", decodeValue("url", actual)), test.value, `${test.id}: default roundtrip`);
  retained++;
}
console.log(`C03U: ${vectors.length} actual-owner vectors and ${retained} production metadata defaults passed (Node ${process.version}, ICU ${process.versions.icu}); application execution not covered`);
"#,
    )
    .unwrap();

    // File-backed output avoids pipe deadlock and retains failure detail.
    // Each compiler child has a 10s deadline; the whole Node seam has 90s.
    let stdout = scratch.0.join("node.stdout");
    let stderr = scratch.0.join("node.stderr");
    let spawned = Command::new("node")
        .arg(&runner)
        .arg(&root)
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(&scratch.0)
        .current_dir(&root)
        .stdout(Stdio::from(File::create(&stdout).unwrap()))
        .stderr(Stdio::from(File::create(&stderr).unwrap()))
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("SKIP URL production metadata: Node unavailable");
            return;
        }
        Err(error) => panic!("could not start Node: {error}"),
    };
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(90) {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "URL production metadata exceeded 90s\n{}\n{}",
                fs::read_to_string(&stdout).unwrap(),
                fs::read_to_string(&stderr).unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = fs::read_to_string(&stdout).unwrap();
    assert!(
        status.success(),
        "URL production metadata failed\n{output}\n{}",
        fs::read_to_string(&stderr).unwrap()
    );
    eprint!("{output}");
}

#[cfg(not(unix))]
#[test]
fn url_values_retain_authored_text_through_production_metadata() {
    eprintln!("SKIP URL production metadata: Unix package symlink setup required");
}
