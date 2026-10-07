//! Audit-only public API observer. It does not choose expected outcomes.
use canlang_compiler::cli::{Analyzer, CatalogAnalyzer};
use canlang_compiler::codegen::{emit, to_json_string, EmitOptions, EmitSources};
use canlang_compiler::source::{SourceDb, SourceId};
use canlang_compiler::syntax::{lex, lex_bytes, parse_source};
use serde_json::{json, Value};
use std::path::PathBuf;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).unwrap();
    if let Err(d) = lex_bytes(SourceId(0), &bytes) {
        println!("{}", json!({"byte_admission": "rejected", "code": d.code,
            "span": [d.primary.start, d.primary.end]}));
        return;
    }
    let text = String::from_utf8(bytes).unwrap();
    let (tree, parse_diags) = parse_source(SourceId(0), &text);
    let kinds: Vec<_> = tree.descendants().map(|n| json!({"kind": format!("{:?}", n.kind),
        "span": [n.span.start, n.span.end]})).collect();
    let strings: Vec<_> = lex(SourceId(0), &text).lines.into_iter()
        .flat_map(|l| l.tokens).filter(|t| t.string_value.is_some())
        .map(|t| json!({"span": [t.span.start, t.span.end], "code_points":
            t.string_value.unwrap().chars().map(|c| c as u32).collect::<Vec<_>>()})).collect();
    let mut db = SourceDb::new();
    db.add(args[1].clone(), text);
    let analysis = CatalogAnalyzer::new(Some(PathBuf::from(&args[2])), None,
        PathBuf::from(&args[3])).analyze_owned(&db, "step7-syntax-probe");
    let result: Value = serde_json::from_str(&analysis.result.to_json()).unwrap();
    let program = analysis.program.as_ref().unwrap();
    let mut observation = json!({"byte_admission": "accepted",
        "coverage": tree.verify_coverage(db.get(SourceId(0)).unwrap().text.len() as u32).is_ok(),
        "parse_codes": parse_diags.iter().map(|d| d.code).collect::<Vec<_>>(),
        "nodes": kinds, "decoded_strings": strings, "analysis": result,
        "modules": program.modules.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        "symbols": program.symbols.iter().map(|s| s.canonical.as_str()).collect::<Vec<_>>(),
        "effect_table_counts": {"models": program.effects.models.len(),
            "scenarios": program.effects.scenarios.len(), "modules": program.effects.modules.len(),
            "descriptions": program.effects.checked_descriptions.len()},
        "emission": "blocked-by-analysis-errors"});
    if !analysis.result.has_errors() {
        let (artifact, diagnostics) = emit(program, &EmitSources {db: &db,
            result: &analysis.result, catalog: analysis.catalog.as_ref(), options: EmitOptions::new()});
        observation["emission"] = json!({"codes": diagnostics.iter().map(|d| d.code).collect::<Vec<_>>(),
            "diagnostics": diagnostics.iter().map(|d| json!({"code": d.code,
                "message": d.message, "span": [d.primary.start,d.primary.end]})).collect::<Vec<_>>(),
            "artifact": serde_json::from_str::<Value>(&to_json_string(&artifact)).unwrap()});
    }
    println!("{}", observation);
}
