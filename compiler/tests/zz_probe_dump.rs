use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const SOURCE: &str = include_str!("../../probe-tmp/b3h.can");

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().into()
}

#[test]
fn zz_dump_b2() {
    let mut db = SourceDb::new();
    let file = db.add("b3h.can".into(), SOURCE.into());
    let path = root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "ProbeB3h.receive")
        .unwrap();
    let disclosure = program.scenario_disclosures().get(&owner.id).unwrap();
    let facts = disclosure.source_facts().unwrap();
    println!("DISCLOSURE: {}", if matches!(disclosure, ScenarioDisclosure::Complete(_)) { "complete" } else { "DECLINED" });
    let ird = ir.scenario_disclosures.get(&owner.id).unwrap();
    println!("IR DISCLOSURE: {}", if matches!(ird, ScenarioDisclosure::Complete(_)) { "complete" } else { "DECLINED" });
    if let ScenarioDisclosure::Complete(ic) = ird {
        println!("IR returns: {}", ic.returns.len());
        for r in &ic.returns {
            println!(
                "IR RETURN start={} influences={}",
                r.node.start,
                r.influences
                    .iter()
                    .map(|i| format!("{:?}:{}", i.kind, &i.query_id.as_deref().unwrap_or("none")[..4]))
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
    }
    let checked = match disclosure {
        ScenarioDisclosure::Complete(checked) => checked,
        ScenarioDisclosure::Declined(declined) => {
            println!("decline reason: {} node={:?}", declined.reason, declined.node);
            return;
        }
    };
    let facts = checked.source_facts.as_deref().unwrap();
    let ird = ir.scenario_disclosures.get(&owner.id).unwrap();
    println!("IR DISCLOSURE: {}", if matches!(ird, ScenarioDisclosure::Complete(_)) { "complete" } else { "DECLINED" });
    if let ScenarioDisclosure::Complete(ic) = ird {
        println!("IR returns: {}", ic.returns.len());
        for r in &ic.returns {
            println!(
                "IR RETURN start={} influences={}",
                r.node.start,
                r.influences
                    .iter()
                    .map(|i| format!("{:?}:{}", i.kind, &i.query_id.as_deref().unwrap_or("none")[..4]))
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
    }
    println!("QUERIES: {}", facts.queries.as_deref().map(|q| q.len()).unwrap_or(999));
    for q in facts.queries.as_deref().unwrap_or_default() {
        println!(
            "QUERY id={} model={} first={} count={} proj={} card={} deps={} influences={}",
            &q.id[..8],
            q.model_name,
            q.first.is_some(),
            q.count.is_some(),
            q.projection.is_some(),
            q.cardinality_guard.is_some(),
            q.dependencies
                .iter()
                .map(|d| format!("{}:{:?}", d.field_name, d.role))
                .collect::<Vec<_>>()
                .join(","),
            q.influences.len()
        );
        if let Some(first) = &q.first {
            println!(
                "  first contained_parent={} target_consumed={} guard_consumed={}",
                first.contained_parent.is_some(),
                first.target_consumed,
                first.guard_consumed
            );
        }
        if let Some(count) = &q.count {
            println!(
                "  count contained_parent={} parent_edges={}",
                count.contained_parent.is_some(),
                count.parent_edges.len()
            );
        }
    }
    println!("RETURNS: {}", checked.returns.len());
    for r in &checked.returns {
        println!(
            "RETURN model_result={} influences={} deps={} intr={}",
            r.node.start,
            r.influences
                .iter()
                .map(|i| format!("{:?}:{}", i.kind, &i.query_id.as_deref().unwrap_or("?")[..6]))
                .collect::<Vec<_>>()
                .join(","),
            r.dependencies.len(),
            r.intrinsics.len()
        );
    }
    panic!("dump only");
}
