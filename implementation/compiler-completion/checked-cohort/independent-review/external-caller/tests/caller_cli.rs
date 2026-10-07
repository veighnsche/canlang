use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use canlang_compiler::analysis::check_program;
use canlang_compiler::cli::{Analyzer, OwnedAnalysis, dispatch_with};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::SourceDb;

struct EquivalentForeignAnalyzer;
impl Analyzer for EquivalentForeignAnalyzer {
    fn analyze(&self, _: &SourceDb, tool_version: &str) -> DiagnosticResult {
        DiagnosticResult::new(tool_version, LANGUAGE_VERSION, SCHEMA_VERSION)
    }
    fn analyze_owned(&self, original: &SourceDb, tool_version: &str) -> OwnedAnalysis {
        let mut foreign = SourceDb::new();
        for (_, source) in original.iter() { foreign.add(source.path.clone(), source.text.clone()); }
        let files = foreign.iter().map(|(id, _)| id).collect::<Vec<_>>();
        let (program, diagnostics) = check_program(&foreign, &files, None);
        assert!(diagnostics.is_empty());
        OwnedAnalysis { program: Some(program), catalog: None, result: self.analyze(original, tool_version) }
    }
}

#[test]
fn public_cli_injected_equivalent_foreign_program_is_rejected_before_shipping() {
    let path = std::env::temp_dir().join(format!("cohort-cli-caller-{}.can", std::process::id()));
    std::fs::write(&path, "app Review\nGiven\n Record { title:text=\"PINNED\" }\nWhen\nThen\n").unwrap();
    let dispatched = dispatch_with(&["can".into(), "compile".into(), "--format=json".into(), path.display().to_string()], &EquivalentForeignAnalyzer);
    std::fs::remove_file(path).unwrap();
    assert_eq!(dispatched.code, 10);
    assert!(dispatched.stdout.contains("E6011"));
    assert!(!dispatched.stdout.contains("\"modules\":"));
    assert!(!dispatched.stdout.contains("PINNED"));
}
