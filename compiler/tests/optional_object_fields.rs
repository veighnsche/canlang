//! Published std object fields preserve omission and supplied-value checking.
use canlang_compiler::analysis::types::ResolvedType;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn source(fields: &str) -> String {
    format!(
        "app OptionalOutcome\nuse std {{OperationOutcome}}\nGiven\n event Observed {{value:OperationOutcome}}\nWhen\n scenario publish() by=members\n  do\n   emit Observed {{value={{{fields}}}}}\nThen\n"
    )
}

fn check(source: &str) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("optional-outcome.can".into(), source.into());
    check_program(&db, &[id], None)
}

#[test]
fn operation_outcome_accepts_omitted_optional_fields_and_retains_enum_facts() {
    for optional in [
        "",
        ",reference=\"room\"",
        ",detail=\"Restored\"",
        ",reference=null,detail=null",
        ",reference=\"room\",detail=\"Restored\"",
    ] {
        let source = source(&format!(
            "source=\"request\",revision=1,state=released{optional}"
        ));
        let (checked, diagnostics) = check(&source);
        assert!(diagnostics.is_empty(), "{optional}: {diagnostics:?}");
        let start = source.find("state=released").unwrap() + "state=".len();
        let key = checked
            .types
            .resolved_cases
            .iter()
            .find(|key| key.start == start as u32 && key.end == (start + "released".len()) as u32)
            .expect("omission preserves the checked std enum case");
        assert!(matches!(
            checked.types.node_types.get(key),
            Some(ResolvedType::Enum { cases, owner: None })
                if cases.iter().any(|case| case == "released")
        ));
    }
}

#[test]
fn operation_outcome_rejects_missing_required_and_malformed_fields() {
    for fields in [
        "revision=1,state=released",
        "source=\"request\",state=released",
        "source=\"request\",revision=1",
        "source=null,revision=1,state=released",
        "source=\"request\",revision=null,state=released",
        "source=\"request\",revision=1,state=null",
        "source=1,revision=1,state=released",
        "source=\"request\",revision=\"one\",state=released",
        "source=\"request\",revision=1,state=\"released\"",
        "source=\"request\",revision=1,state=released,reference=1",
        "source=\"request\",revision=1,state=released,detail=false",
    ] {
        let (_, diagnostics) = check(&source(fields));
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E3001"),
            "missing or malformed fields must fail: {fields}: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| diagnostic.code == "E3001"),
            "negative source must parse and resolve: {fields}: {diagnostics:?}"
        );
    }
}

#[test]
fn operation_outcome_rejects_foreign_enum_cases_and_owners() {
    let source = source("source=\"request\",revision=1,state=foreign_state");
    let (checked, diagnostics) = check(&source);
    let start = source.find("state=foreign_state").unwrap() + "state=".len();
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "E2001"
                && diagnostic.primary.start <= start as u32
                && (start as u32) < diagnostic.primary.end
        }),
        "{diagnostics:?}"
    );
    assert!(
        !checked
            .types
            .resolved_cases
            .iter()
            .any(|key| { key.start <= start as u32 && (start as u32) < key.end })
    );

    let source = source
        .replace(" event Observed", " contract Foreign {state:enum(pending,confirmed,unavailable,failed,unknown,released)}\n event Observed")
        .replace("publish()", "publish(other:Foreign)")
        .replace("state=foreign_state", "state=other.state");
    let (_, diagnostics) = check(&source);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3001"),
        "foreign enum owner must fail: {diagnostics:?}"
    );
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code == "E3001"),
        "{diagnostics:?}"
    );
}
