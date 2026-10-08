//! Bounded checked-app locale producer. These tests exercise checked
//! metadata and existing appDefinition emission, without runtime context claims.

use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn check(source: &str) -> (SourceDb, CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("authored-business.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[id], None);
    (db, program, diagnostics)
}

fn locale(program: &CheckedProgram, name: &str) -> Option<String> {
    let module = program
        .modules
        .iter()
        .find(|module| module.name == name)
        .unwrap();
    program.effects.modules[&module.id]
        .app_default_locale
        .clone()
}

fn emit_clean(source: &str) -> (CheckedProgram, String) {
    let (db, program, diagnostics) = check(source);
    assert!(diagnostics.is_empty(), "check: {diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, None);
    assert!(diagnostics.is_empty(), "IR: {diagnostics:?}");
    let output = js::emit_program(&ir);
    assert!(
        output.diagnostics.is_empty(),
        "JS: {:?}",
        output.diagnostics
    );
    (program, output.entry.js)
}

#[test]
fn explicit_default_and_pinned_fallback_are_independent_of_source_language() {
    for (context, expected) in [("", "en"), ("context\n locale default=\"nl\"\n", "nl")] {
        let source = format!("app Authored source=\"de\"\n{context}Given\nWhen\nThen\n");
        let (program, emitted) = emit_clean(&source);
        assert_eq!(locale(&program, "Authored").as_deref(), Some(expected));
        assert!(emitted.contains(&format!(
            "id:\"Authored\",uses:[],appDefaultLocale:\"{expected}\""
        )));
    }
}

#[test]
fn recursive_fold_coalesces_explicit_values_before_applying_defaults() {
    let source = concat!(
        "app Office uses=[Left,Right]\n",
        "app Left uses=[Tasks,Plain]\n",
        "app Right uses=[Tasks]\ncontext\n locale default=\"nl\"\n",
        "app Tasks\ncontext\n locale default=\"nl\"\nGiven\nWhen\nThen\n",
        "app Plain\nGiven\nWhen\nThen\n",
    );
    let (program, emitted) = emit_clean(source);
    for name in ["Office", "Left", "Right", "Tasks"] {
        assert_eq!(locale(&program, name).as_deref(), Some("nl"));
    }
    assert_eq!(locale(&program, "Plain").as_deref(), Some("en"));
    assert!(emitted.contains("id:\"Office\",uses:[\"Left\",\"Right\"],appDefaultLocale:\"nl\""));
    assert!(emitted.contains("\"Left\":{uses:[\"Tasks\",\"Plain\"],appDefaultLocale:\"nl\"}"));
    assert!(emitted.contains("\"Right\":{uses:[\"Tasks\"],appDefaultLocale:\"nl\"}"));
    assert!(emitted.contains("\"Tasks\":{uses:[],appDefaultLocale:\"nl\"}"));
    assert!(emitted.contains("\"Plain\":{uses:[],appDefaultLocale:\"en\"}"));
}

#[test]
fn explicit_child_locale_wins_over_omission_in_either_member_order() {
    for members in ["Plain,Dutch", "Dutch,Plain"] {
        let source = format!(
            "app Office uses=[{members}]\napp Plain\nGiven\nWhen\nThen\napp Dutch\ncontext\n locale default=\"nl\"\nGiven\nWhen\nThen\n"
        );
        let (program, _) = emit_clean(&source);
        assert_eq!(locale(&program, "Office").as_deref(), Some("nl"));
    }
}

#[test]
fn incompatible_explicit_siblings_and_parent_context_diagnose() {
    for (own_context, child_locale) in [("", "de"), ("context\n locale default=\"de\"\n", "nl")] {
        let source = format!(
            "app Office uses=[Dutch,Other]\n{own_context}app Dutch\ncontext\n locale default=\"nl\"\nGiven\nWhen\nThen\napp Other\ncontext\n locale default=\"{child_locale}\"\nGiven\nWhen\nThen\n"
        );
        let (_, program, diagnostics) = check(&source);
        let conflicts: Vec<_> = diagnostics.iter().filter(|d| d.code == "E2002").collect();
        assert!(!conflicts.is_empty(), "missing conflict: {diagnostics:?}");
        assert_eq!(
            conflicts.len(),
            diagnostics.len(),
            "unexpected diagnostics: {diagnostics:?}"
        );
        for diagnostic in conflicts {
            assert!(
                diagnostic.message.contains("Office")
                    && diagnostic.message.contains("incompatible explicit locale")
            );
            assert!(
                source[diagnostic.primary.start as usize..diagnostic.primary.end as usize]
                    .contains("locale default=")
            );
            assert_eq!(diagnostic.related.len(), 1);
            let span = diagnostic.related[0].span;
            assert!(source[span.start as usize..span.end as usize].contains("locale default="));
        }
        assert_eq!(locale(&program, "Office"), None);
    }
}

#[test]
fn importing_an_implicit_app_package_does_not_import_its_context() {
    let source = concat!(
        "app Office uses=[Consumer]\n",
        "package Consumer\n use Dutch {greeting}\n Given\n When\n Then\n",
        "app Dutch\ncontext\n locale default=\"nl\"\nGiven\n export message greeting = \"Hi\"@{}\nWhen\nThen\n",
    );
    let (program, emitted) = emit_clean(source);
    assert_eq!(locale(&program, "Office").as_deref(), Some("en"));
    assert_eq!(locale(&program, "Consumer"), None);
    assert_eq!(locale(&program, "Dutch").as_deref(), Some("nl"));
    assert!(emitted.contains("id:\"Office\",uses:[\"Consumer\"],appDefaultLocale:\"en\""));
}

#[test]
fn existing_locale_validation_and_duplicate_checks_still_apply() {
    for (context, code) in [
        (" locale default=\"not_a_tag\"\n", "E3001"),
        (" locale default=\"nl\"\n locale default=\"nl\"\n", "E2002"),
    ] {
        let source = format!("app T\ncontext\n{context}Given\nWhen\nThen\n");
        let (_, _, diagnostics) = check(&source);
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{diagnostics:?}"
        );
    }
}
