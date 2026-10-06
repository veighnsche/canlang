use canlang_compiler::analysis::{check_program, catalog::{load_catalog, CatalogRequest}};
use canlang_compiler::codegen::{emit, EmitOptions, EmitSources};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, SourceId, Span};
fn main() {
    let raw = r#""\b\f\uD83D\uDE00""#;
    let src = format!("app Probe uses=[probe]\npackage probe\n Given\n  contract Empty {{value:text}}\n When\n  scenario pick() read=true -> text by=members\n   do\n    return {raw}\n Then\n  page / title=\"Probe\"\n   text \"probe\"\n");
    let path = std::path::Path::new("/private/tmp/canlang-codegen-string-catalog.json");
    std::fs::write(path, r#"{"language_version":"1.0","catalog_version":"1.0.0","entries":[]}"#).unwrap();
    let (catalog, errors) = load_catalog(&CatalogRequest {flag:Some(path), env:None, cwd:std::path::Path::new("/private/tmp"), primary:Span::new(SourceId(0),0,0)});
    assert!(errors.is_empty(), "catalog errors: {errors:?}");
    let mut db = SourceDb::new();
    let id = db.add("probe.can".into(), src);
    let decoded = canlang_compiler::syntax::lexer::decode_json_string(raw,0,id).unwrap();
    println!("lexer codepoints: {:?}", decoded.chars().map(|c|c as u32).collect::<Vec<_>>());
    let (program, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    println!("analysis diagnostics: {diagnostics:?}");
    let mut result = DiagnosticResult::new("probe", "1.0", 1);
    result.complete = true;
    let (artifact, diagnostics) = emit(&program, &EmitSources {db:&db, result:&result, catalog:catalog.as_ref(), options:EmitOptions::new()});
    println!("emission diagnostics: {diagnostics:?}");
    for module in artifact.modules {
        for line in module.js.lines().filter(|line|line.contains("return ")) {
            println!("JS: {line}");
        }
    }
    let mut unicode_db = SourceDb::new();
    let unicode_id = unicode_db.add("unicode.can".into(), "é😀x".into());
    let map = canlang_compiler::codegen::sourcemap::build("unicode.mjs", &unicode_db,
        &[canlang_compiler::codegen::js::JsLine {line:1, span:Span::new(unicode_id,6,7), name:None}]);
    let decoded = canlang_compiler::codegen::sourcemap::decode_mappings(&map.mappings).unwrap();
    println!("source-map observation: text=é😀x, span start=6 UTF8 bytes, emitted originalColumn={:?}, UTF16 column before x=3", decoded[0][0].src_col);
}
