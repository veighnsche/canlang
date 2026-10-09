//! Checked declaration identity survives model-grouped registry lowering.
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrModelRuleKind, IrProgram};
use canlang_compiler::source::SourceDb;

fn build(source: &str) -> (CheckedProgram, IrProgram) {
    let mut db = SourceDb::new();
    let id = db.add("model-rules.can".into(), source.into());
    let (checked, diagnostics) = check_program(&db, &[id], None);
    assert!(diagnostics.is_empty(), "analysis: {diagnostics:?}");
    let (program, diagnostics) = ir::build(&checked, &db, None);
    assert!(diagnostics.is_empty(), "IR: {diagnostics:?}");
    (checked, program)
}

#[test]
fn interleaved_rules_keep_declaring_module_target_and_global_order() {
    let source = "package Office\n Given\n  Item {qty:int,title:text,closed:bool}\n  Bin {qty:int,title:text,closed:bool}\n  policy Item read=public\n  policy Bin read=public\n  invariant Bin: row.qty>=0\n  lock Item fields=title\n  invariant Item: row.qty>=0\n  unique Item fields=qty where=row.closed\n  lock Bin fields=title when=row.closed\n  invariant Item: row.qty<=100\n When\n Then\npackage Warehouse\n Given\n  Item {qty:int,title:text}\n  policy Item read=public\n  invariant Item: row.qty>=0\n  lock Item fields=title\n When\n Then\n";
    let (checked, program) = build(source);
    let mut origins: Vec<_> = program
        .invariants
        .iter()
        .filter_map(|rule| {
            rule.origin.as_ref().map(|origin| {
                assert_eq!(origin.registry_id, rule.id);
                assert_eq!(origin.span, rule.span);
                assert_eq!(origin.kind, IrModelRuleKind::Invariant);
                origin
            })
        })
        .chain(program.locks.iter().map(|rule| {
            assert_eq!(rule.origin.registry_id, rule.id);
            assert_eq!(rule.origin.span, rule.span);
            assert_eq!(rule.origin.kind, IrModelRuleKind::Lock);
            &rule.origin
        }))
        .collect();
    origins.sort_by_key(|origin| origin.ordinal);
    let expected = [
        (
            "Office",
            "Office.Bin",
            "Bin.require.1",
            "invariant Bin: row.qty>=0",
        ),
        (
            "Office",
            "Office.Item",
            "Item.lock.1",
            "lock Item fields=title",
        ),
        (
            "Office",
            "Office.Item",
            "Item.require.1",
            "invariant Item: row.qty>=0",
        ),
        (
            "Office",
            "Office.Bin",
            "Bin.lock.1",
            "lock Bin fields=title when=row.closed",
        ),
        (
            "Office",
            "Office.Item",
            "Item.require.2",
            "invariant Item: row.qty<=100",
        ),
        (
            "Warehouse",
            "Warehouse.Item",
            "Item.require.1",
            "invariant Item: row.qty>=0",
        ),
        (
            "Warehouse",
            "Warehouse.Item",
            "Item.lock.1",
            "lock Item fields=title",
        ),
    ];
    assert_eq!(origins.len(), expected.len());
    for (origin, (module, target, registry, authored)) in origins.iter().zip(expected) {
        assert_eq!(checked.modules[origin.module.0 as usize].name, module);
        assert_eq!(checked.symbols[origin.model.0 as usize].canonical, target);
        assert_eq!(origin.registry_id, registry);
        assert_eq!(origin.node.file, origin.span.file);
        assert_eq!(origin.node.start, origin.span.start);
        assert_eq!(origin.node.end, origin.span.end);
        assert_eq!(
            source[origin.span.start as usize..origin.span.end as usize].trim(),
            authored
        );
        let model = &checked.effects.models[&origin.model];
        match origin.kind {
            IrModelRuleKind::Invariant => {
                let rule = model
                    .invariants
                    .iter()
                    .find(|rule| rule.node == origin.node)
                    .unwrap();
                assert_eq!(rule.target, origin.model);
                assert_eq!(rule.module, origin.module);
                assert_eq!(rule.id, origin.ordinal);
            }
            IrModelRuleKind::Lock => {
                let rule = model
                    .locks
                    .iter()
                    .find(|rule| rule.node == origin.node)
                    .unwrap();
                assert_eq!(rule.module, origin.module);
                assert_eq!(rule.id, origin.ordinal);
            }
        }
    }
    assert!(
        origins
            .windows(2)
            .all(|pair| pair[0].ordinal < pair[1].ordinal)
    );
    assert!(
        origins
            .windows(2)
            .all(|pair| pair[0].span.start < pair[1].span.start)
    );
    assert!(program.read_rules.iter().all(|rule| rule.origin.is_none()));
    let unique = program
        .invariants
        .iter()
        .filter(|rule| rule.id == "Item.unique.1")
        .collect::<Vec<_>>();
    assert_eq!(unique.len(), 1);
    assert!(
        unique[0].origin.is_none(),
        "conditional uniqueness is not a final-row invariant"
    );
    let unconditional = program
        .locks
        .iter()
        .filter(|rule| rule.when.is_none())
        .collect::<Vec<_>>();
    assert_eq!(unconditional.len(), 2);
    assert!(unconditional.iter().all(|rule| rule.fields == ["title"]));
    let conditional = program
        .locks
        .iter()
        .find(|rule| rule.id == "Bin.lock.1")
        .unwrap();
    assert!(conditional.when.is_some());
    assert_eq!(conditional.fields, ["title"]);
}
