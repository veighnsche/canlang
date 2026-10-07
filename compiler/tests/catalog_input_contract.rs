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
    text: impl AsRef<[u8]>,
) -> (
    Option<canlang_compiler::analysis::catalog::Catalog>,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
    Span,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    std::fs::write(&path, text.as_ref()).unwrap();
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

fn cli(text: impl AsRef<[u8]>) -> std::process::Output {
    let dir = tempfile::tempdir().unwrap();
    let catalog = dir.path().join("catalog.json");
    let source = dir.path().join("anchor.can");
    std::fs::write(&catalog, text.as_ref()).unwrap();
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

fn assert_catalog_rejected(bytes: &[u8], utf8_error: bool) {
    let (catalog, diagnostics, primary) = loader(bytes);
    assert!(catalog.is_none());
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics[0].code, "E6003");
    assert_eq!(diagnostics[0].primary, primary);
    if utf8_error {
        assert!(diagnostics[0].message.contains("not valid UTF-8"));
    }
    let output = cli(bytes);
    assert!(!output.status.success());
    // This decoder is independent of the shared parser being qualified.
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let diagnostics = value["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["code"], "E6003");
    assert_eq!(diagnostics[0]["primary"]["file"], 0);
    assert_eq!(diagnostics[0]["primary"]["start"], 0);
    assert_eq!(diagnostics[0]["primary"]["end"], 0);
    if utf8_error {
        assert!(
            diagnostics[0]["message"]
                .as_str()
                .unwrap()
                .contains("not valid UTF-8")
        );
    }
}

fn document_with_extra(extra: &str) -> String {
    let mut text = document(ENTRY);
    text.pop();
    format!("{text},{extra}}}")
}

#[test]
fn ignored_catalog_extras_still_require_strict_complete_json() {
    for extra in [
        r#""unknown":"\uD800""#,
        r#""unknown":"\uDC00""#,
        r#""unknown":{"\uD800":0}"#,
        r#""\uDC00":0"#,
        r#""unknown":{"$serde_json::private::RawValue":"\uD800"}"#,
        r#""unknown":01"#,
        r#""unknown":1e+"#,
        r#""unknown":1."#,
        "\"unknown\":\"é\n\"",
    ] {
        assert_catalog_rejected(document_with_extra(extra).as_bytes(), false);
    }
    assert_catalog_rejected(format!("{} trailing", document(ENTRY)).as_bytes(), false);
}

#[test]
fn catalog_unknown_value_depth_counts_from_envelope_root() {
    // Envelope enters depth 0, unknown value depth 1. A terminal scalar
    // or empty container under 63 wrappers enters depth 64; 64 enters 65.
    for terminal in ["0", "[]", "{}"] {
        for wrappers in [63, 64] {
            let value = format!(
                "{}{}{}",
                "[".repeat(wrappers),
                terminal,
                "]".repeat(wrappers)
            );
            let text = document_with_extra(&format!("\"unknown\":{value}"));
            if wrappers == 64 {
                assert_catalog_rejected(text.as_bytes(), false);
            } else {
                let (catalog, diagnostics, _) = loader(&text);
                assert!(diagnostics.is_empty(), "{diagnostics:?}");
                assert!(catalog.unwrap().lookup("trim").is_some());
                let output = cli(&text);
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stdout)
                );
                let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(value["diagnostics"], serde_json::json!([]));
                assert_eq!(value["complete"], true);
            }
        }
    }
}

#[test]
fn catalog_invalid_utf8_bytes_keep_catalog_code_and_source_primary() {
    let mut bytes = document_with_extra("\"unknown\":\"sentinel\"").into_bytes();
    let start = bytes
        .windows(8)
        .position(|window| window == b"sentinel")
        .unwrap();
    bytes[start] = 0xff;
    assert_catalog_rejected(&bytes, true);
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
