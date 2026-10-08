use canlang_compiler::analysis::{check_program, catalog::{CatalogRequest, load_catalog}};
use canlang_compiler::codegen::{emit, ir, EmitOptions, EmitSources};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::path::Path;

const LEAF: &str = " corpus Handbook model=Missing scope=parent title=title content=body where=true from=deployment.knowledge\n";

fn main() {
    let root = Path::new("/Users/vince/Projects/canlang");
    let catalog_path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path), env: None, cwd: root,
        primary: Span::new(SourceId(0), 0, 0),
    });
    assert!(diagnostics.is_empty());
    let catalog = catalog.unwrap();
    let mut db = SourceDb::new();
    db.add("unselected.can".into(), format!("app Unselected\nGiven\n{LEAF}When\nThen\n"));
    let clean = db.add("clean.can".into(), "app Clean\nGiven\n Item { title:text=\"corpus Phantom model=Missing\" }\n ## corpus Phantom model=Missing\nWhen\nThen\n".into());
    let source = format!("app Selected\nGiven\n{LEAF}{LEAF}When\nThen\n");
    let selected = db.add("selected.can".into(), source.clone());
    let (program, diagnostics) = check_program(&db, &[clean], Some(&catalog));
    assert!(diagnostics.is_empty());
    let (before_ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty());
    assert_eq!(before_ir.modules.len(), 1);
    assert_eq!(before_ir.modules[0].name, "Clean");
    let result = DiagnosticResult::new("independent-corpus-probe", LANGUAGE_VERSION, SCHEMA_VERSION);
    let (artifact, diagnostics) = emit(&program, &EmitSources { db: &db, result: &result, catalog: Some(&catalog), options: EmitOptions::new() });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(!artifact.modules.is_empty());
    db.add("append.can".into(), format!("app Append\nGiven\n{LEAF}When\nThen\n"));
    let (after_ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty());
    assert_eq!(after_ir.modules.len(), 1);
    assert_eq!(before_ir.modules[0].name, after_ir.modules[0].name);
    let (appended_artifact, diagnostics) = emit(&program, &EmitSources { db: &db, result: &result, catalog: Some(&catalog), options: EmitOptions::new() });
    assert!(diagnostics.is_empty());
    assert_eq!(artifact.modules.len(), appended_artifact.modules.len());
    assert_eq!(artifact.modules[0].js, appended_artifact.modules[0].js);
    println!("PASS clean static strings/comments and nonzero selected source; unselected and appended Corpus do not emit refusal");
    let (program, diagnostics) = check_program(&db, &[selected, clean], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (artifact, diagnostics) = emit(&program, &EmitSources { db: &db, result: &result, catalog: Some(&catalog), options: EmitOptions::new() });
    assert_eq!(diagnostics.len(), 2, "{diagnostics:?}");
    assert!(!artifact.modules.is_empty());
    let starts: Vec<_> = source.match_indices("corpus ").map(|(start,_)| start as u32).collect();
    for (diagnostic, start) in diagnostics.iter().zip(starts) {
        assert_eq!(diagnostic.code, "E6008");
        assert!(diagnostic.message.contains("corpus Selected.Handbook:"));
        assert_eq!(diagnostic.primary, Span::new(selected, start, start + LEAF.trim().len() as u32));
    }
    println!("PASS duplicate authored occurrences each retain selected owning canonical name and exact significant span; public artifact plus errors contract preserved");
}
