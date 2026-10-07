use canlang_compiler::{analysis, codegen, source::{SourceDb, Span}, syntax};
use std::path::Path;

fn main() {
    let path = std::env::args().nth(1).expect("source path");
    let mut db = SourceDb::new();
    let id = db.add(path.clone(), std::fs::read_to_string(&path).unwrap());
    let request = analysis::catalog::CatalogRequest {
        flag: Some(Path::new("packages/values/dist/catalog.json")), env: None,
        cwd: Path::new("."), primary: Span::new(id, 0, 0),
    };
    let (catalog, mut diags) = analysis::catalog::load_catalog(&request);
    assert!(diags.is_empty());
    eprintln!("begin parse");
    let (tree, parsed) = syntax::parse(&db, id);
    assert!(parsed.is_empty());
    assert!(tree.verify_coverage(db.get(id).unwrap().text.len() as u32).is_ok());
    let trees = vec![(id, tree)];
    eprintln!("begin resolve");
    let resolved = analysis::resolve::resolve_program(&db, &trees, catalog.as_ref(), &mut diags);
    eprintln!("begin types");
    let types = analysis::types::check_types(&db, &trees, catalog.as_ref(), &resolved, &mut diags);
    analysis::resolve::emit_unresolved(&db, &resolved, &types, &mut diags);
    eprintln!("begin effects");
    let effects = analysis::effects::check_effects(&db, &trees, &resolved, &types, catalog.as_ref(), &mut diags);
    eprintln!("begin examples");
    let examples = analysis::examples::check_examples(&db, &trees, &resolved, &types, catalog.as_ref(), &mut diags);
    assert!(diags.is_empty(), "{diags:?}");
    let program = analysis::CheckedProgram {
        modules: resolved.modules, symbols: resolved.symbols, types, effects, examples,
        catalog_version: catalog.as_ref().unwrap().version().to_string(),
    };
    eprintln!("begin IR");
    let (ir, diags) = codegen::ir::build(&program, &db, catalog.as_ref());
    assert!(diags.is_empty(), "{diags:?}");
    let mode = std::env::args().nth(2).unwrap_or_default();
    if mode == "lower" {
        let mut selected = 0;
        for item in &ir.items {
            if let codegen::ir::IrItemKind::Scenario { effects, .. } = &item.kind {
                for statement in effects {
                    if let codegen::ir::IrStmt::Return { value: Some(expr), .. } = statement {
                        let mut emitter = codegen::js::Emitter::new(&ir);
                        selected += 1;
                        eprintln!("begin direct lower_expr");
                        let value = emitter.lower_expr(expr);
                        let (diagnostics, _, _, _) = emitter.finish();
                        assert!(diagnostics.is_empty(), "{diagnostics:?}");
                        println!("{value}");
                        eprintln!("direct lower_expr complete {} bytes", value.len());
                    }
                }
            }
        }
        assert_eq!(selected, 1, "one checked arithmetic return selected");
        eprintln!("begin drop");
        drop(ir); drop(program); drop(trees);
        eprintln!("all stages complete");
        return;
    }
    if mode == "clone" {
        eprintln!("begin IR item clone");
        let cloned = ir.items.clone();
        eprintln!("IR item clone complete");
        drop(cloned); drop(ir); drop(program); drop(trees);
        eprintln!("all stages complete");
        return;
    }
    eprintln!("begin JS");
    let output = codegen::js::emit_program(&ir);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    eprintln!("begin drop");
    drop(output); drop(ir); drop(program); drop(trees);
    eprintln!("all stages complete");
}
