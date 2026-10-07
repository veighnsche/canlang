//! Real loader and fresh CLI witnesses; authored fixture expectations are independent.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::source::{SourceDb, Span};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;

const ENTRY: &str = r#"{"id":"trim","kind":"builtin","signature":"trim(value:S)->text","effects":"pure","availability":"implemented","js":"trim","owner":"test"}"#;
const SOURCE: &str = "app Shop\nGiven\n Gadget { title:text }\nWhen\nThen\n";

fn document(entries: &str) -> String {
    format!(
        r#"{{"language_version":"1.0","catalog_version":"independent-test","entries":[{entries}]}}"#
    )
}

fn loader(
    text: &str,
) -> (
    Option<canlang_compiler::analysis::catalog::Catalog>,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
    Span,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    std::fs::write(&path, text).unwrap();
    let mut db = SourceDb::new();
    let id = db.add("anchor.can".into(), SOURCE.into());
    let primary = Span::new(id, 0, 0);
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: dir.path(),
        primary,
    });
    (catalog, diagnostics, primary)
}

fn cli(text: &str) -> std::process::Output {
    let dir = tempfile::tempdir().unwrap();
    let catalog = dir.path().join("catalog.json");
    let source = dir.path().join("anchor.can");
    std::fs::write(&catalog, text).unwrap();
    std::fs::write(&source, SOURCE).unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["check", "--format=json", "--catalog"])
        .arg(catalog)
        .arg(source)
        .current_dir(dir.path())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap()
}

#[test]
fn loader_and_cli_retain_first_decoded_member_and_ignore_unknown_extras() {
    let entry = ENTRY.replace(r#""id":"trim""#, r#""id":"trim","\u0069d":"wrong","kind":"builtin","kind":false,"unknown":{"$serde_json::private::Number":"123"}"#);
    let text = format!(
        r#"{{"language_version":"1.0","language_version":"wrong","catalog_version":"first","catalog_version":null,"entries":[{entry}],"entries":false,"unknown":[1e99999999999999999999,-0,true,null]}}"#
    );
    let (catalog, diagnostics, _) = loader(&text);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    assert_eq!(catalog.version(), "first");
    assert!(catalog.lookup("trim").is_some());
    assert!(catalog.lookup("wrong").is_none());
    let output = cli(&text);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn syntax_envelope_entry_and_signature_failures_keep_codes_and_source_anchor() {
    for (text, code) in [
        ("{\"é\":0,\n bad}".to_string(), "E6003"),
        ("[]".to_string(), "E6003"),
        (document(&format!("{ENTRY},{ENTRY}")), "E6003"),
        (
            document(&ENTRY.replace("trim(value:S)->text", "not a signature")),
            "E6004",
        ),
    ] {
        let (catalog, diagnostics, primary) = loader(&text);
        assert!(catalog.is_none());
        assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
        assert_eq!(diagnostics[0].code, code);
        assert_eq!(diagnostics[0].primary, primary);
        let output = cli(&text);
        assert!(!output.status.success());
        let value =
            canlang_compiler::json::parse(std::str::from_utf8(&output.stdout).unwrap()).unwrap();
        let diagnostics = value.get("diagnostics").unwrap().as_arr().unwrap();
        assert_eq!(diagnostics[0].get("code").unwrap().as_str(), Some(code));
        let span = diagnostics[0].get("primary").unwrap();
        assert_eq!(span.get("start").unwrap().as_i64(), Some(0));
        assert_eq!(span.get("end").unwrap().as_i64(), Some(0));
    }
}

#[test]
fn available_producer_catalog_loads_without_rebuilding_packages() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let profile = [
        "packages/values/src/catalog.ts",
        "packages/values/scripts/emit-catalog.mjs",
        "packages/values/dist/src/catalog.js",
        "packages/values/dist/src/index.js",
        "packages/values/dist/catalog.json",
    ];
    for relative in profile {
        let path = root.join(relative);
        if !path.is_file() {
            eprintln!(
                "SKIP available_producer_catalog_loads_without_rebuilding_packages: missing profile input {relative}"
            );
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        eprintln!(
            "PROFILE {relative}: bytes={} sha256={:x}",
            bytes.len(),
            Sha256::digest(&bytes)
        );
    }
    let text = std::fs::read_to_string(root.join("packages/values/dist/catalog.json")).unwrap();
    let (catalog, diagnostics, _) = loader(&text);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    for id in ["trim", "count", "sum", "money"] {
        assert!(catalog.lookup(id).is_some(), "producer missing {id}");
    }
    let output = cli(&text);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}
