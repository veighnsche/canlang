//! Presentation gates establish stable facts only inside their card/tab.
use canlang_compiler::analysis::types::{ResolvedType, Scalar};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

const SOURCE: &str = "app GuardedRows\nGiven\n Entry {name:text,parent:Entry?,other:Entry?}\n policy Entry read=public\nWhen\nThen\n page /rows title=\"Rows\"\n  list Entry\n   card \"Parent\"\n    require row.parent!=null\n    require row.parent.name!=\"\"\n    text row.parent.name\n    tabs\n     tab \"Other\"\n      require row.other!=null\n      text row.other.name\n      text row.parent.name\n   text row.name\n";

fn check(source: &str) -> (SourceDb, CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("ui-guard.can".into(), source.into());
    let (checked, diagnostics) = check_program(&db, &[id], None);
    (db, checked, diagnostics)
}

#[test]
fn card_and_tab_gates_narrow_descendants_and_preserve_ordered_ir_gates() {
    let (db, checked, diagnostics) = check(SOURCE);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for (key, ty) in &checked.types.node_types {
        if SOURCE[key.start as usize..key.end as usize].trim() == "row.parent.name"
            || SOURCE[key.start as usize..key.end as usize].trim() == "row.other.name"
        {
            assert_eq!(ty, &ResolvedType::Scalar(Scalar::Text));
        }
    }
    let (program, diagnostics) = ir::build(&checked, &db, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let card = &program.modules[0].pages[0].render[0].children[0];
    assert_eq!(card.factory, "card");
    assert!(matches!(
        card.gate.as_ref().unwrap().expr,
        IrExpr::Binary { .. }
    ));
    assert_eq!(card.children[0].factory, "text");
    let tab = &card.children[1].children[0];
    assert_eq!(tab.factory, "tabItem");
    assert!(tab.gate.is_some());
    assert_eq!(tab.children.len(), 2);
}

#[test]
fn presentation_facts_do_not_escape_or_establish_unsafe_null_proofs() {
    for (before, after) in [
        ("   text row.name", "   text row.parent.name"),
        (
            "   text row.name",
            "   card \"Sibling\"\n    text row.parent.name",
        ),
        (
            "      text row.parent.name",
            "      text row.parent.name\n     tab \"Sibling\"\n      text row.other.name",
        ),
        (
            "    text row.parent.name",
            "    text row.parent.name\n    list Entry\n     text row.parent.name",
        ),
        ("require row.parent!=null", "require row.parent==null"),
        ("require row.parent!=null", "require row.parent?.name!=null"),
        (
            "require row.parent!=null",
            "require row.parent!=null or true",
        ),
    ] {
        let source = SOURCE.replace(before, after);
        let (_, _, diagnostics) = check(&source);
        assert!(
            diagnostics.iter().any(|d| d.code == "E3003"),
            "{after}: {diagnostics:?}"
        );
    }
    let source = SOURCE.replace("require row.parent!=null", "require 1");
    let (_, _, diagnostics) = check(&source);
    assert!(
        diagnostics.iter().any(|d| d.code == "E3007"),
        "{diagnostics:?}"
    );
    assert!(
        diagnostics.iter().any(|d| d.code == "E3003"),
        "{diagnostics:?}"
    );
}

#[test]
fn a_local_actor_gate_does_not_authenticate_sibling_widgets() {
    let source = SOURCE.replace(
        "   text row.name",
        "   card \"Signed in\"\n    require actor!=null\n    text actor.id\n   text row.name",
    );
    let (_, _, diagnostics) = check(&source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let source = source.replace("   text row.name", "   text actor.id");
    let (_, _, diagnostics) = check(&source);
    assert!(
        diagnostics.iter().any(|d| d.code == "E3003"),
        "{diagnostics:?}"
    );
}
