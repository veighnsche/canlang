//! Named message signatures cover every slot, including an empty signature.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn check(source: &str, catalog: Option<&Catalog>) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("message-slot-coverage.can".into(), source.into());
    check_program(&db, &[id], catalog).1
}

fn declaration(value: &str) -> String {
    format!("app MessageCoverage\nGiven\n message notice {value}\nWhen\nThen\n")
}

fn assert_unknown_slots(source: &str, literal: &str, slots: &[&str]) {
    let diagnostics = check(source, None);
    assert_eq!(diagnostics.len(), slots.len(), "{source}: {diagnostics:?}");
    let start = source.find(literal).unwrap();
    for slot in slots {
        let message = format!("message placeholder '{{{slot}}}' names no message parameter");
        let diagnostic = diagnostics.iter().find(|d| d.message == message).unwrap();
        assert_eq!(diagnostic.code, "E3016");
        assert_eq!(diagnostic.primary.start as usize, start);
        assert_eq!(diagnostic.primary.end as usize, start + literal.len());
    }
}

#[test]
fn zero_parameter_source_slots_are_rejected_at_the_literal() {
    for (literal, slots) in [
        ("\"Hi {name}\"", vec!["name"]),
        ("\"{count,number,integer}\"", vec!["count"]),
        ("\"{kind,select,other {Hi {name}}}\"", vec!["kind", "name"]),
    ] {
        assert_unknown_slots(&declaration(&format!("= {literal}@{{}}")), literal, &slots);
    }
}

#[test]
fn zero_parameter_translation_slots_are_rejected_at_the_literal() {
    for (literal, slots) in [
        ("\"Hoi {name}\"", vec!["name"]),
        ("\"{count,number,integer}\"", vec!["count"]),
        ("\"{kind,select,other {Hoi {name}}}\"", vec!["kind", "name"]),
    ] {
        let source = declaration(&format!("= \"Hi\"@{{nl={literal}}}"));
        assert_unknown_slots(&source, literal, &slots);
    }
}

#[test]
fn static_quoted_and_null_translations_need_no_parameters() {
    for value in [
        "= \"Hi\"@{}",
        "= \"'{name}'\"@{nl=\"'{count,number}'\"}",
        "= \"Hi\"@{\"pt-BR\"=\"Oi\",nl=null}",
    ] {
        let source = declaration(value);
        let diagnostics = check(&source, None);
        assert!(diagnostics.is_empty(), "{source}: {diagnostics:?}");
    }
}

#[test]
fn parameterized_messages_keep_coverage_and_translation_subsets() {
    let source = declaration(
        "(kind:text,name:text,count:int) = \"{kind,select,other {Hi {name}: {count,number}}}\"@{nl=\"{name}\",fr=null}",
    );
    let diagnostics = check(&source, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let literal = "\"{kind,select,other {Hi {missing}}}\"";
    let source = declaration(&format!("(kind:text) = {literal}@{{}}"));
    assert_unknown_slots(&source, literal, &["missing"]);
}

#[test]
fn raw_inline_slots_remain_structurally_valid() {
    // Captions and descriptions validate raw descriptors structurally.
    let source = "app MessageCoverage\nGiven\n Item { name:text desc=\"Hi {name}\"@{nl=\"Hoi {name}\"} } label=\"{kind,select,other {Item {name}}}\"@{}\n policy Item read=members\nWhen\nThen\n";
    let diagnostics = check(source, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
}

#[test]
fn static_named_and_inline_descriptors_accept_null_locale() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("catalog-load.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: std::path::Path::new("."),
        primary: canlang_compiler::source::Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    for expression in [
        "format(notice,locale=null)",
        "format(personal(name=\"Bo\"),locale=null)",
        "format(\"Hi\"@{nl=null},locale=null)",
    ] {
        let source = format!(
            "app MessageCoverage\nGiven\n message notice = \"Hi\"@{{nl=null}}\n message personal(name:text) = \"Hi {{name}}\"@{{nl=\"Hoi {{name}}\"}}\nWhen\n scenario greet() by=members\n  do\n   let greeting = {expression}\nThen\n"
        );
        let diagnostics = check(&source, Some(&catalog));
        assert!(diagnostics.is_empty(), "{source}: {diagnostics:?}");
    }
}
