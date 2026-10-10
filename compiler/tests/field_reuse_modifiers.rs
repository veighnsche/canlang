use canlang_compiler::{
    analysis::check_program,
    codegen::ir::{self, IrExpr, IrItemKind},
    source::SourceDb,
};

#[test]
fn borrowed_field_modifiers_keep_defining_sources_and_receiving_behavior() {
    let source = "package base\n Given\n  export Task {title:text trim min=1 max=4000 unique,description:text max=8000,version:int min=1,tags:int[]!}\n When\n Then\napp Borrow\nuse base {Task}\nGiven\n contract Fact {title:Task.title max=2000,description:Task.description,version:Task.version,tags:Task.tags}\n contract Narrow {title:Fact.title min=2 max=1000}\nWhen\nThen\n";
    let mut db = SourceDb::new();
    let file = db.add("borrowed.can".into(), source.into());
    let (checked, diagnostics) = check_program(&db, &[file], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&checked, &db, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let field = |name: &str| {
        lowered
            .items
            .iter()
            .find(|item| item.canonical == name)
            .unwrap()
    };
    let IrItemKind::Field {
        modifiers,
        default,
        server,
        required_array,
        ..
    } = &field("Borrow.Fact.title").kind
    else {
        panic!()
    };
    assert!(modifiers.trim);
    assert!(matches!(
        modifiers.min.as_ref().unwrap().expr,
        IrExpr::Int(1)
    ));
    assert!(matches!(
        modifiers.max.as_ref().unwrap().expr,
        IrExpr::Int(2000)
    ));
    assert_eq!(
        &source[modifiers.min.as_ref().unwrap().span.start as usize
            ..modifiers.min.as_ref().unwrap().span.end as usize],
        "1"
    );
    assert!(!modifiers.unique && !modifiers.machine && !required_array);
    assert!(default.is_none() && server.is_none());
    let IrItemKind::Field { modifiers, .. } = &field("Borrow.Narrow.title").kind else {
        panic!()
    };
    assert!(modifiers.trim);
    assert!(matches!(
        modifiers.min.as_ref().unwrap().expr,
        IrExpr::Int(2)
    ));
    assert!(matches!(
        modifiers.max.as_ref().unwrap().expr,
        IrExpr::Int(1000)
    ));
    for (name, bound, is_min) in [
        ("Borrow.Fact.description", 8000, false),
        ("Borrow.Fact.version", 1, true),
    ] {
        let IrItemKind::Field { modifiers, .. } = &field(name).kind else {
            panic!()
        };
        let value = if is_min {
            &modifiers.min
        } else {
            &modifiers.max
        };
        assert!(matches!(value.as_ref().unwrap().expr, IrExpr::Int(number) if number==bound));
    }
    let IrItemKind::Field { required_array, .. } = &field("Borrow.Fact.tags").kind else {
        panic!()
    };
    assert!(!required_array, "required-input marker is not borrowed");
}

#[test]
fn receiving_field_cannot_publish_a_weaker_or_incompatible_inherited_range() {
    for bounds in ["min=0", "max=11", "min=11"] {
        let source = format!(
            "app Bounds\nGiven\n contract Original {{value:int min=1 max=10}}\n contract Copy {{value:Original.value {bounds}}}\nWhen\nThen\n"
        );
        let mut db = SourceDb::new();
        let file = db.add("bounds.can".into(), source);
        let (checked, diagnostics) = check_program(&db, &[file], None);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (_, diagnostics) = ir::build(&checked, &db, None);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("reused field bound")),
            "{bounds}: {diagnostics:?}"
        );
    }
}
