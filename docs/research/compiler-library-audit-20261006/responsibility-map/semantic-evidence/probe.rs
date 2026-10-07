//! Audit observer: expected outcomes live in cases.json, not this observer.
use canlang_compiler::cli::{Analyzer, CatalogAnalyzer};
use canlang_compiler::codegen::{emit, EmitOptions, EmitSources};
use canlang_compiler::source::{SourceDb, SourceId};
use canlang_compiler::syntax::parse_source;
use serde_json::{json, Value};
use std::path::PathBuf;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let text = std::fs::read_to_string(&args[1]).unwrap();
    let (tree, parse_diags) = parse_source(SourceId(0), &text);
    let mut db = SourceDb::new();
    db.add(args[1].clone(), text);
    let analysis = CatalogAnalyzer::new(Some(PathBuf::from(&args[2])), None,
        PathBuf::from(&args[3])).analyze_owned(&db, "step8-semantic-probe");
    let result: Value = serde_json::from_str(&analysis.result.to_json()).unwrap();
    let p = analysis.program.as_ref().unwrap();
    let symbols: Vec<_> = p.symbols.iter().filter_map(|s| p.types.symbol_types.get(&s.id)
        .map(|t| json!({"symbol": s.canonical, "type": format!("{t:?}")}))).collect();
    let mut nodes: Vec<_> = p.types.node_types.iter().map(|(k,t)|
        json!({"key": format!("{k:?}"), "type": format!("{t:?}")})).collect();
    nodes.sort_by_key(|n| n["key"].to_string());
    let mut out = json!({"parse_codes": parse_diags.iter().map(|d|d.code).collect::<Vec<_>>(),
        "coverage": tree.verify_coverage(db.get(SourceId(0)).unwrap().text.len() as u32).is_ok(),
        "analysis": result, "symbol_types": symbols, "node_types": nodes,
        "effect_counts": {"models":p.effects.models.len(),"scenarios":p.effects.scenarios.len()},
        "emission": "blocked-by-analysis-errors"});
    if !analysis.result.has_errors() {
        let (a, ds) = emit(p, &EmitSources {db:&db,result:&analysis.result,
            catalog:analysis.catalog.as_ref(), options:EmitOptions::new()});
        out["emission"] = json!({"diagnostics":ds.iter().map(|d|json!({"code":d.code,
            "message":d.message,"span":[d.primary.start,d.primary.end]})).collect::<Vec<_>>(),
            "modules":a.modules.iter().map(|m|json!({"path":m.path,"js":m.js})).collect::<Vec<_>>()});
    }
    println!("{out}");
}
