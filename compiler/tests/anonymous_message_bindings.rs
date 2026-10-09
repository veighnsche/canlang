//! Anonymous descriptors use explicit inferred bindings and the native formatter.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

fn catalog() -> Catalog {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("catalog-anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

#[test]
fn anonymous_messages_reject_invalid_bindings_and_inferred_icu_schemas() {
    let catalog = catalog();
    for (expression, code) in [
        ("format(\"{n}|{missing}\"@{}(n=1),locale=null)", "E3016"),
        (
            "format(\"source\"@{nl=\"{n}|{missing}\"}(n=1),locale=null)",
            "E3016",
        ),
        ("format(\"{n}\"@{}(extra=1),locale=null)", "E3005"),
        // Duplicate and positional binding shapes are owned by the parser.
        ("format(\"{n}\"@{}(n=1,n=2),locale=null)", "E1202"),
        ("format(\"{n}\"@{}(1),locale=null)", "E1215"),
        ("format(\"{n}\"@{}(n=null),locale=null)", "E5009"),
        ("format(\"{n}\"@{}(n=[1]),locale=null)", "E5009"),
        ("format(\"{n}\"@{}(n={value=1}),locale=null)", "E5009"),
        (
            "format(\"{n,plural,one {one} other {many}}\"@{}(n=\"one\"),locale=null)",
            "E5007",
        ),
        ("format(\"{n,date}\"@{}(n=1),locale=null)", "E5007"),
        ("format(\"{n,time}\"@{}(n=2026-10-09),locale=null)", "E5007"),
        (
            "format(\"{n}\"@{nl=\"{n,number}\"}(n=\"one\"),locale=null)",
            "E5007",
        ),
        (
            "format(\"{n,number,currency}\"@{}(n=1),locale=null)",
            "E5007",
        ),
        (
            "format(\"{n,plural,one {one}}\"@{}(n=1),locale=null)",
            "E5007",
        ),
        (
            "format(\"{n}\"@{\"bad tag\"=\"{n}\"}(n=1),locale=null)",
            "E3016",
        ),
    ] {
        let source = format!(
            "app AnonymousNegative\nGiven\n derive value():text = {expression}\nWhen\nThen\n"
        );
        let mut db = SourceDb::new();
        let id = db.add("anonymous-negative.can".into(), source);
        let (_, diagnostics) = check_program(&db, &[id], Some(&catalog));
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{expression}: {diagnostics:?}"
        );
        if !code.starts_with("E1") {
            assert!(
                diagnostics
                    .iter()
                    .all(|diagnostic| !diagnostic.code.starts_with("E1")),
                "semantic negative must parse: {expression}: {diagnostics:?}"
            );
        }
    }

    // A same-named lexical value is never an implicit descriptor binding.
    let mut db = SourceDb::new();
    let id = db.add("no-capture.can".into(), "app NoCapture\nGiven\n derive value(n:int,missing:int):text = format(\"{n}|{missing}\"@{}(n=n),locale=null)\nWhen\nThen\n".into());
    let (_, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3016"),
        "{diagnostics:?}"
    );
}

#[test]
fn anonymous_local_aliases_preserve_exact_descriptor_provenance() {
    let catalog = catalog();
    for (initializer, code) in [
        ("\"ordinary text\"", Some("E3005")),
        ("{source=\"literal\",variants={}}", Some("E3005")),
        ("\"{unbound}\"@{}", Some("E5007")),
        ("\"plain\"@{nl=\"{unbound}\"}", Some("E5007")),
        ("\"plain\"@{}", None),
        ("\"{n}\"@{nl=\"{n,number}\"}(n=1)", None),
    ] {
        let source = format!(
            "app Aliases\nGiven\nWhen\n scenario run() by=members\n  do\n   let descriptor={initializer}\n   let alias=((descriptor))\n   let final=alias\n   let rendered=format(locale=null,descriptor=((final)))\nThen\n"
        );
        let mut db = SourceDb::new();
        let file = db.add("aliases.can".into(), source);
        let (_, diagnostics) = check_program(&db, &[file], Some(&catalog));
        if let Some(code) = code {
            assert!(
                diagnostics.iter().any(|d| d.code == code),
                "{initializer}: {diagnostics:?}"
            );
        } else {
            assert!(diagnostics.is_empty(), "{initializer}: {diagnostics:?}");
        }
    }
    let source = "app Shadow\nGiven\nWhen\n scenario run(descriptor:text) by=members\n  do\n   if true\n    let descriptor=\"checked\"@{}\n    let rendered=format(descriptor,locale=null)\n   let rendered=format(descriptor,locale=null)\nThen\n";
    let mut db = SourceDb::new();
    let file = db.add("shadow.can".into(), source.into());
    let (_, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert_eq!(
        diagnostics.iter().filter(|d| d.code == "E3005").count(),
        1,
        "{diagnostics:?}"
    );
}

#[cfg(unix)]
#[test]
fn anonymous_descriptors_cannot_escape_into_plain_text_business_values() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let header = "app Escapes\nGiven\n Item {value:text}\n policy Item read=members\n derive accept(value:text):text=value\nWhen\n scenario run(row:Item) -> text by=members\n  do\n";
    for (shape, bindings, value) in [
        ("direct", "", "\"Hi\"@{}"),
        ("grouped", "", "((\"Hi\"@{}))"),
        ("bound", "", "\"Hi {name}\"@{}(name=\"Ada\")"),
        (
            "chained",
            "   let first=\"Hi {name}\"@{}(name=\"Ada\")\n   let alias=((first))\n   let final=alias\n",
            "((final))",
        ),
    ] {
        for (sink, statement) in [
            ("return", format!("return {value}")),
            (
                "create",
                format!("create Item {{value={value}}} as created"),
            ),
            ("set", format!("set row {{value={value}}}")),
            ("parameter", format!("let result=accept({value})")),
            (
                "nested",
                format!("let result=accept(({{value={value}}}).value)"),
            ),
        ] {
            let source = format!("{header}{bindings}   {statement}\n   return \"done\"\nThen\n");
            let path = scratch.path().join(format!("{shape}-{sink}.can"));
            std::fs::write(&path, source).unwrap();
            let compiled = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
                .args(["compile", "--format=json", "--catalog"])
                .arg(root.join("packages/values/dist/catalog.json"))
                .arg(path)
                .env_remove("CAN_CATALOG")
                .output()
                .unwrap();
            let response: serde_json::Value = serde_json::from_slice(&compiled.stdout).unwrap();
            assert_eq!(
                compiled.status.code(),
                Some(10),
                "{shape}/{sink}: {response}"
            );
            assert!(
                response["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == "E3001"),
                "{shape}/{sink}: {response}"
            );
            assert!(
                response.get("modules").is_none(),
                "{shape}/{sink}: {response}"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn anonymous_messages_compile_and_execute_native_date_time_and_plural_bindings() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script = scratch.path().join("anonymous-consumer.mjs");
    std::fs::write(
        &script,
        include_str!("fixtures/anonymous-message-consumer.mjs"),
    )
    .unwrap();
    let result = std::process::Command::new("node")
        .arg(script)
        .arg(root)
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&result.stdout));
}
