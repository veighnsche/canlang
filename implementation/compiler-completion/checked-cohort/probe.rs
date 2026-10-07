use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::cli::{Analyzer, CatalogAnalyzer};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, to_json_string};
use canlang_compiler::diagnostic::{DiagnosticResult, Severity};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use std::path::{Path, PathBuf};

fn analyze(db: &SourceDb, catalog: &Path) -> (CheckedProgram, DiagnosticResult, Catalog) {
    let owned = CatalogAnalyzer::new(Some(catalog.to_path_buf()), None, PathBuf::from("/private/tmp"))
        .analyze_owned(db, "step5-probe");
    assert!(owned.result.complete);
    assert!(!owned.result.has_errors(), "analysis: {:?}", owned.result.diagnostics);
    (owned.program.unwrap(), owned.result, owned.catalog.unwrap())
}
fn load(path: &Path) -> Catalog {
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(path), env: None, cwd: Path::new("/private/tmp"), primary: Span::new(SourceId(0),0,0)
    });
    assert!(diagnostics.is_empty(), "catalog: {diagnostics:?}");
    catalog.unwrap()
}
fn run(out: &Path, name: &str, program: &CheckedProgram, db: &SourceDb, result: &DiagnosticResult, catalog: &Catalog) -> String {
    let (artifact, diagnostics) = emit(program, &EmitSources { db, result, catalog:Some(catalog), options:EmitOptions::new() });
    std::fs::write(out.join(format!("{name}.artifact.json")), to_json_string(&artifact)).unwrap();
    std::fs::write(out.join(format!("{name}.diagnostics.txt")), format!("{diagnostics:#?}\n")).unwrap();
    println!("CASE {name}: analysis_catalog={}, emission_catalog={}, source_count={}, errors={}, requires={:?}", program.catalog_version, catalog.version(), artifact.sources.len(), diagnostics.iter().filter(|d|d.severity==Severity::Error).count(), artifact.requires);
    assert!(!diagnostics.iter().any(|d|d.severity==Severity::Error), "{name}: {diagnostics:?}");
    artifact.modules.iter().map(|m|m.js.as_str()).collect::<Vec<_>>().join("\n")
}
fn main() {
    let args:Vec<_>=std::env::args().collect();
    let out=Path::new(&args[1]);let catalog_path=Path::new(&args[2]);
    let old="app Shop\nGiven\n Gadget { title:text=\"OLD\" }\nWhen\nThen\n";
    let new=old.replace("OLD","NEW");assert_eq!(old.len(),new.len());
    let mut db=SourceDb::new();db.add("same.can".into(),old.into());
    let (program,result,catalog)=analyze(&db,catalog_path);
    let control=run(out,"coherent-control",&program,&db,&result,&catalog);
    assert!(control.contains("\"OLD\""));assert!(!control.contains("\"NEW\""));
    let mut replacement=SourceDb::new();replacement.add("same.can".into(),new.clone());
    let changed=run(out,"foreign-db-same-id-and-spans",&program,&replacement,&result,&catalog);
    assert!(changed.contains("\"NEW\""));assert!(!changed.contains("\"OLD\""));
    assert_ne!(result.sources[0].sha256,replacement.get(SourceId(0)).unwrap().sha256);
    println!("WITNESS foreign database: checked old hash {}, emitted new hash {} with changed default and no provenance rejection",result.sources[0].sha256,replacement.get(SourceId(0)).unwrap().sha256);
    db.add("same.can".into(),new);
    let appended=run(out,"same-db-append-is-immutable-control",&program,&db,&result,&catalog);
    assert!(appended.contains("\"OLD\""));assert!(!appended.contains("\"NEW\""));
    println!("WITNESS append: original SourceId remains OLD; latest path id is {:?}; artifact includes both revisions",db.lookup("same.can"));

    let calls="app Shop\nGiven\nWhen\n scenario echo(value:text) read=true -> text by=members\n  do\n   return lower(value)\nThen\n";
    let mut cdb=SourceDb::new();cdb.add("call.can".into(),calls.into());
    let (cprogram,cresult,ccatalog)=analyze(&cdb,catalog_path);
    let baseline=run(out,"catalog-control",&cprogram,&cdb,&cresult,&ccatalog);
    assert!(baseline.contains("lower("));assert!(!baseline.contains("await lower("));
    for name in ["catalog-major-mismatch","catalog-same-version-content-change"] {
        let second=load(&out.join(format!("{name}.json")));
        let changed=run(out,name,&cprogram,&cdb,&cresult,&second);
        assert!(changed.contains("await lower("));
        println!("WITNESS {name}: old checked catalog label retained, new state-read effect changes emitted awaiting; no mismatch rejection");
    }
    let one="app One\nGiven\n Thing { title:text=\"ONE\" }\nWhen\nThen\n";
    let two=one.replace("One","Two").replace("ONE","TWO");
    let mut ordered=SourceDb::new();let a=ordered.add("one.can".into(),one.into());let b=ordered.add("two.can".into(),two.clone());
    let (p,r,c)=analyze(&ordered,catalog_path);
    let original=run(out,"two-file-control",&p,&ordered,&r,&c);
    let mut swapped=SourceDb::new();swapped.add("two.can".into(),two);swapped.add("one.can".into(),one.into());
    let altered=run(out,"foreign-db-swapped-files",&p,&swapped,&r,&c);
    assert_ne!(original,altered);
    println!("WITNESS swapped database: old symbol identities retained against differently numbered source bytes; emission changed");
    let (reversed,diagnostics)=check_program(&ordered,&[b,a],Some(&c));
    println!("OBSERVATION same-db reversed check files: module_names={:?}, diagnostics={:?}",reversed.modules.iter().map(|m|m.name.as_str()).collect::<Vec<_>>(),diagnostics.iter().map(|d|d.code).collect::<Vec<_>>());
    // A completeness acknowledgment is independent of cohort coherence.
    let mut incomplete = DiagnosticResult::new("cohort-probe", canlang_compiler::LANGUAGE_VERSION, canlang_compiler::SCHEMA_VERSION);
    incomplete.add_sources(&ordered);
    incomplete.complete = false;
    let (blocked, blocked_diags) = emit(&p, &EmitSources { db: &ordered, result: &incomplete, catalog: Some(&c), options: EmitOptions::new() });
    assert!(blocked.modules.is_empty());
    assert_eq!(blocked_diags.iter().map(|d| d.code).collect::<Vec<_>>(), vec!["E6005"]);
    println!("GATE incomplete production: E6005, empty executable artifact");
    let (allowed, allowed_diags) = emit(&p, &EmitSources { db: &ordered, result: &incomplete, catalog: Some(&c), options: EmitOptions::test_only() });
    assert!(!allowed.modules.is_empty());
    assert!(!allowed_diags.iter().any(|d|d.severity == Severity::Error));
    println!("GATE incomplete test-only: acknowledged coherent fixture emits");
    let (bypass, bypass_diags) = emit(&p, &EmitSources { db: &swapped, result: &incomplete, catalog: Some(&c), options: EmitOptions::test_only() });
    assert!(!bypass.modules.is_empty());
    assert!(!bypass_diags.iter().any(|d|d.severity == Severity::Error));
    println!("GATE incomplete test-only currently also admits swapped cohort");
    // Checking an explicit subset does not make other DB files checked.
    let (subset, subset_diags) = check_program(&ordered, &[a], Some(&c));
    assert!(subset_diags.is_empty());
    let subset_js = run(out, "checked-subset", &subset, &ordered, &r, &c);
    assert!(subset_js.contains("ONE")); assert!(!subset_js.contains("TWO"));
    println!("SUBSET selected source emits ONE, artifact source inventory still includes TWO");
    println!("ALL public API provenance assertions passed; no emitted JavaScript executed");
}
