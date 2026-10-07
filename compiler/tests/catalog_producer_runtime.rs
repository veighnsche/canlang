//! Execute the owning producer and runtime without rebuilding or writing packages.
#![cfg(unix)]

use canlang_compiler::analysis::catalog::{Availability, CatalogRequest, load_catalog};
use canlang_compiler::source::{SourceDb, Span};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;

fn hash_profile(label: &str, path: &Path) {
    let bytes = std::fs::read(path).unwrap();
    eprintln!(
        "PROFILE {label}: bytes={} sha256={:x}",
        bytes.len(),
        Sha256::digest(bytes)
    );
}

#[test]
fn unchanged_catalog_producer_matches_authored_source_and_feeds_real_consumers() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let values = root.join("packages/values");
    for relative in [
        "src/catalog.ts",
        "scripts/emit-catalog.mjs",
        "dist/src/catalog.js",
        "dist/src/index.js",
        "dist/catalog.json",
    ] {
        let path = values.join(relative);
        if !path.is_file() {
            eprintln!("SKIP catalog_producer_runtime: missing packages/values/{relative}");
            return;
        }
        hash_profile(&format!("packages/values/{relative}"), &path);
    }
    let version = match Command::new("node").arg("--version").output() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("SKIP catalog_producer_runtime: Node unavailable");
            return;
        }
        Err(error) => panic!("Node profile failed: {error}"),
        Ok(output) => output,
    };
    assert!(version.status.success());
    let version = std::str::from_utf8(&version.stdout).unwrap().trim();
    eprintln!("PROFILE Node {version}");
    let major: u32 = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    if major < 24 {
        eprintln!("SKIP catalog_producer_runtime: Node24 type stripping required, found {version}");
        return;
    }

    let scratch = tempfile::tempdir().unwrap();
    let isolated = scratch.path().join("values");
    std::fs::create_dir_all(isolated.join("scripts")).unwrap();
    std::fs::create_dir_all(isolated.join("dist")).unwrap();
    let producer = isolated.join("scripts/emit-catalog.mjs");
    std::fs::copy(values.join("scripts/emit-catalog.mjs"), &producer).unwrap();
    assert_eq!(
        std::fs::read(&producer).unwrap(),
        std::fs::read(values.join("scripts/emit-catalog.mjs")).unwrap()
    );
    std::os::unix::fs::symlink(values.join("dist/src"), isolated.join("dist/src")).unwrap();

    // Direct source import uses Node's type stripping; the only source import
    // is a type import. Runtime imports resolve through the real dist tree.
    let compare = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            r#"
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [sourcePath, builtPath, runtimePath] = process.argv.slice(1);
const source = await import(pathToFileURL(sourcePath));
const built = await import(pathToFileURL(builtPath));
const runtime = await import(pathToFileURL(runtimePath));
assert.deepEqual(source.CATALOG, built.CATALOG, 'authored and built CATALOG differ');
assert.equal(runtime.trim('  é😀  '), 'é😀');
console.log(`source-built equality; actual runtime trim; entries=${source.CATALOG.entries.length}`);
"#,
        ])
        .arg(values.join("src/catalog.ts"))
        .arg(values.join("dist/src/catalog.js"))
        .arg(values.join("dist/src/index.js"))
        .output()
        .unwrap();
    assert!(
        compare.status.success(),
        "source/runtime comparison failed: {}",
        String::from_utf8_lossy(&compare.stderr)
    );
    eprintln!(
        "EXECUTED {}",
        String::from_utf8_lossy(&compare.stdout).trim()
    );
    let emitted = Command::new("node")
        .arg(&producer)
        .current_dir(&isolated)
        .output()
        .unwrap();
    assert!(
        emitted.status.success(),
        "actual producer failed: {}",
        String::from_utf8_lossy(&emitted.stderr)
    );
    eprintln!(
        "EXECUTED {}",
        String::from_utf8_lossy(&emitted.stdout).trim()
    );
    let fresh = isolated.join("dist/catalog.json");
    hash_profile("fresh isolated dist/catalog.json", &fresh);
    assert_eq!(
        std::fs::read(&fresh).unwrap(),
        std::fs::read(values.join("dist/catalog.json")).unwrap(),
        "fresh owning producer differs from existing catalog bytes"
    );

    let source = scratch.path().join("producer.can");
    let text = "app Shop\nGiven\n Gadget { title:text }\nWhen\nThen\n";
    std::fs::write(&source, text).unwrap();
    let mut db = SourceDb::new();
    let id = db.add(source.display().to_string(), text.into());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&fresh),
        env: None,
        cwd: scratch.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    for name in ["trim", "count", "sum", "money"] {
        assert!(
            catalog.lookup(name).is_some(),
            "missing independent expected builtin {name}"
        );
    }
    assert_eq!(catalog.availability("sum"), Some(Availability::Implemented));
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["check", "--format=json", "--catalog"])
        .arg(&fresh)
        .arg(&source)
        .current_dir(scratch.path())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fresh catalog CLI failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let decoded: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(decoded["diagnostics"], serde_json::json!([]));
    assert_eq!(decoded["complete"], true);
    eprintln!("EXECUTED actual catalog loader and fresh CLI check: complete=true diagnostics=[]");
}
