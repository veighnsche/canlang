use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().into()
}

fn operands() -> Vec<String> {
    std::fs::read_to_string("/tmp/venue-24-operands.txt")
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .collect()
}

#[test]
fn zz_dump_purchase() {
    let root = root();
    let mut db = SourceDb::new();
    let mut files = Vec::new();
    for operand in operands() {
        let text = std::fs::read_to_string(root.join(&operand)).unwrap();
        files.push(db.add(operand, text));
    }
    let path = root.join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &files, Some(&catalog));
    let errors: Vec<_> = diagnostics
        .iter()
        .filter(|d| d.severity == canlang_compiler::diagnostic::Severity::Error)
        .collect();
    println!("CHECK errors: {}", errors.len());
    for error in &errors {
        println!("  CHECK {code} | {message}", code = error.code, message = error.message.chars().take(150).collect::<String>());
    }
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    println!("IR diagnostics: {}", diagnostics.len());
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "CanPurchase.receive")
        .unwrap();
    let disclosure = program.scenario_disclosures().get(&owner.id).unwrap();
    println!(
        "PROGRAM DISCLOSURE: {}",
        if matches!(disclosure, ScenarioDisclosure::Complete(_)) {
            "complete"
        } else {
            "DECLINED"
        }
    );
    if let ScenarioDisclosure::Declined(declined) = disclosure {
        println!("decline reason: {} node={:?}", declined.reason, declined.node);
        println!("decline influences: {}", declined.influences.len());
        for influence in &declined.influences {
            println!(
                "  {:?} node={:?} query_id={:?}",
                influence.kind, influence.node, influence.query_id
            );
        }
    }
    let ird = ir.scenario_disclosures.get(&owner.id).unwrap();
    println!(
        "IR DISCLOSURE: {}",
        if matches!(ird, ScenarioDisclosure::Complete(_)) {
            "complete"
        } else {
            "DECLINED"
        }
    );
    if let ScenarioDisclosure::Complete(checked) = disclosure {
        let facts = checked.source_facts.as_deref().unwrap();
        println!(
            "queries: {}",
            facts.queries.as_deref().map(|q| q.len()).unwrap_or(999)
        );
        for q in facts.queries.as_deref().unwrap_or_default() {
            println!(
                "QUERY model={} first={} count={} deps={}",
                q.model_name,
                q.first.is_some(),
                q.count.is_some(),
                q.dependencies
                    .iter()
                    .map(|d| format!("{}:{:?}", d.field_name, d.role))
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
        println!("returns: {}", checked.returns.len());
        for r in &checked.returns {
            println!(
                "RETURN start={} influences={}",
                r.node.start,
                r.influences
                    .iter()
                    .map(|i| format!(
                        "{:?}:{}",
                        i.kind,
                        &i.query_id.as_deref().unwrap_or("none")[..4.min(i.query_id.as_deref().unwrap_or("none").len())]
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
    }
    panic!("dump only");
}
