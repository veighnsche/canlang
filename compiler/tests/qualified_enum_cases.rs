//! Explicit enum cases keep exact domains and ordinary lexical/import lookup.
use canlang_compiler::{analysis::check_program, source::SourceDb};

fn check(source: &str) -> Vec<canlang_compiler::diagnostic::Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("qualified.can".to_string(), source.to_string());
    check_program(&db, &[id], None).1
}

#[test]
fn qualified_enum_cases_refuse_invalid_fields_cases_and_wrappers() {
    for (expression, code) in [
        ("Owner.missing.hold", "E2013"),
        ("Owner.kind.missing", "E2013"),
        ("Owner.text.hold", "E2013"),
        ("Owner.maybe.hold", "E2013"),
        ("Owner.many.hold", "E2013"),
        ("Owner?.kind.hold", "E3001"),
        ("Owner.kind?.hold", "E3001"),
        ("Unknown.kind.hold", "E2001"),
    ] {
        let source = format!(
            "app Qualified\nGiven\n contract Owner {{kind:enum(hold,booking),text:text,maybe:enum(hold,booking)?,many:enum(hold,booking)[]}}\n derive result():Owner.kind = {expression}\nWhen\nThen\n"
        );
        let diags = check(&source);
        assert!(
            diags.iter().any(|d| d.code == code),
            "{expression}: {diags:?}"
        );
    }
}

#[test]
fn qualified_enum_cases_do_not_widen_domains_or_override_bindings() {
    for expression in ["Other.kind.hold", "hold"] {
        let source = format!(
            "app Qualified\nGiven\n contract Owner {{kind:enum(hold,booking)}}\n contract Other {{kind:enum(hold,booking,release)}}\n derive hold():int = 1\n derive result():Owner.kind = {expression}\nWhen\nThen\n"
        );
        let diags = check(&source);
        assert!(
            diags.iter().any(|d| d.code == "E3001"),
            "{expression}: {diags:?}"
        );
    }
    let source = "app Qualified\nGiven\n contract Owner {kind:enum(hold,booking)}\n derive result(Owner:int):text = Owner.kind.hold\nWhen\nThen\n";
    assert!(check(source).iter().any(|d| d.code == "E2013"));
}

#[test]
fn qualified_enum_cases_require_visible_imports() {
    for import in ["", " use values {Other}\n"] {
        let source = format!(
            "app Qualified uses=[values,consumer]\npackage values\n Given\n  export contract Owner {{kind:enum(hold,booking)}}\n  export contract Other {{kind:enum(hold,booking)}}\n When\n Then\npackage consumer\n{import} Given\n  derive result():text = Owner.kind.hold\n When\n Then\n"
        );
        assert!(check(&source).iter().any(|d| d.code == "E2001"));
    }
}

#[test]
fn qualified_enum_cases_are_context_free_defaults() {
    let source = "app Qualified\nGiven\n contract Owner {kind:enum(hold,booking)}\n derive selected(value:Owner.kind=Owner.kind.hold):Owner.kind = value\nWhen\nThen\n preferences {kind:Owner.kind=Owner.kind.booking}\n";
    assert!(check(source).is_empty(), "{:?}", check(source));
}
