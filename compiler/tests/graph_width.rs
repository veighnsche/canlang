//! Finite checked-source graphs and append-only IDs, without runtime/count limits.
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::resolve::SymbolKind;
use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
use canlang_compiler::source::SourceDb;
use std::collections::BTreeSet;

fn graph(shape: &str, width: usize, terminal_cycle: bool) -> (String, BTreeSet<(usize, usize)>) {
    let mut source = "app GraphWidth\nGiven\n".to_string();
    let mut edges = BTreeSet::new();
    for caller in 0..width {
        let targets: Vec<usize> = match shape {
            "chain" if caller + 1 < width => vec![caller + 1],
            "star" if caller + 1 < width => vec![width - 1],
            "dense" => (caller + 1..width).collect(),
            _ if terminal_cycle && caller + 1 == width => vec![caller],
            _ => Vec::new(),
        };
        let expression = if targets.is_empty() {
            "value".to_string()
        } else {
            targets
                .iter()
                .map(|target| {
                    edges.insert((caller, *target));
                    format!("f{target}(value)")
                })
                .collect::<Vec<_>>()
                .join("+")
        };
        source.push_str(&format!(
            " derive f{caller}(value:int):int = {expression}\n"
        ));
    }
    source.push_str("When\nThen\n");
    (source, edges)
}

fn qualify(shape: &str, width: usize, terminal_cycle: bool) {
    let (source, expected_edges) = graph(shape, width, terminal_cycle);
    let mut db = SourceDb::new();
    let file = db.add("graph-width.can".into(), source.clone());
    let (checked, diagnostics) = check_program(&db, &[file], None);
    if terminal_cycle {
        assert_eq!(
            diagnostics.len(),
            1,
            "{shape} {width}: {:?}",
            &diagnostics[..diagnostics.len().min(4)]
        );
        let diagnostic = &diagnostics[0];
        let name = format!("f{}", width - 1);
        assert_eq!(diagnostic.code, "E2018");
        assert_eq!(
            diagnostic.message,
            format!("derived-value cycle through '{name}'")
        );
        let start = source.find(&format!("derive {name}(")).unwrap() + "derive".len();
        assert_eq!(diagnostic.primary.start as usize, start);
        assert_eq!(diagnostic.primary.end as usize, start + 1 + name.len());
    } else {
        assert!(
            diagnostics.is_empty(),
            "{shape} {width}: {:?}",
            &diagnostics[..diagnostics.len().min(4)]
        );
    }
    assert_eq!(checked.modules.len(), 1);
    assert_eq!(checked.modules[0].id.0, 0);
    assert_eq!(checked.modules[0].name, "GraphWidth");
    assert_eq!(
        checked.symbols.len(),
        width * 2,
        "one derive and parameter per declaration"
    );
    assert_eq!(checked.effects.derives.len(), width);
    let mut names = BTreeSet::new();
    for (index, symbol) in checked.symbols.iter().enumerate() {
        assert_eq!(symbol.id.0 as usize, index);
        assert_eq!(symbol.module.0, 0);
        assert!(names.insert(symbol.canonical.clone()));
        if let SymbolKind::DeriveFn { params, .. } = &symbol.kind {
            assert_eq!(params.len(), 1);
            assert_eq!(
                checked.types.symbol_types[&params[0]],
                ResolvedType::Scalar(Scalar::Int)
            );
            assert_eq!(
                checked.types.symbol_results[&symbol.id],
                Some(ResolvedType::Scalar(Scalar::Int))
            );
            assert_eq!(
                checked.effects.derives[&symbol.id].params[0].param,
                params[0]
            );
        }
    }
    assert_eq!(checked.types.selected_calls.len(), expected_edges.len());
    let mut actual_edges = BTreeSet::new();
    for (key, call) in &checked.types.selected_calls {
        let SelectedCallTarget::DeriveFn(target) = call.target else {
            panic!("non-owning call: {call:?}")
        };
        assert_eq!(call.slots, [Some(0)]);
        assert_eq!(call.arguments.len(), 1);
        assert_eq!(
            checked.types.node_types[&call.arguments[0]],
            ResolvedType::Scalar(Scalar::Int)
        );
        assert_eq!(
            checked.types.node_types[key],
            ResolvedType::Scalar(Scalar::Int)
        );
        let caller = checked
            .effects
            .derives
            .values()
            .find(|derive| {
                derive.node.file == key.file
                    && derive.node.start <= key.start
                    && key.end <= derive.node.end
            })
            .unwrap();
        let index = |id: canlang_compiler::analysis::resolve::SymbolId| {
            checked.symbols[id.0 as usize]
                .name
                .strip_prefix('f')
                .unwrap()
                .parse::<usize>()
                .unwrap()
        };
        assert!(actual_edges.insert((index(caller.derive), index(target))));
    }
    assert!(
        actual_edges == expected_edges,
        "{shape} {width}: missing {:?}; unexpected {:?}",
        expected_edges
            .difference(&actual_edges)
            .take(4)
            .collect::<Vec<_>>(),
        actual_edges
            .difference(&expected_edges)
            .take(4)
            .collect::<Vec<_>>()
    );
}

#[test]
fn finite_forward_graph_width_preserves_ids_types_edges_and_cycle_precision() {
    for width in [100, 1000, 3000] {
        qualify("chain", width, false);
        qualify("star", width, false);
    }
    // Complete density stays small: 24 declarations, 276 forward edges.
    qualify("dense", 24, false);
    // New width control: many acyclic origins share one terminal self-cycle.
    // Existing cycle_witness tests own the unchanged mutual/static-call policy.
    qualify("star", 100, true);
}
