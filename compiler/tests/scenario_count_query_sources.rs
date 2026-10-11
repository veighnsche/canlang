//! Exact original count inventory. These facts do not issue native query handles.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::effects::{EffectTables, check_effects};
use canlang_compiler::analysis::resolve::{self, ModelOwner, SymbolKind};
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, DisclosureQuery, ScenarioDisclosure, analyze_scenario_disclosure,
};
use canlang_compiler::analysis::{
    NodeKey, ResolveTables, ResolvedType, Scalar, SymbolId, TypeTable, types,
};
use canlang_compiler::source::{SourceDb, SourceId, Span, sha256_hex};
use canlang_compiler::syntax::{self, SyntaxNode};
use std::collections::HashMap;
use std::path::Path;

const CHAT: &str = include_str!("fixtures/original-a850/CanChat.can");
const CREATIVE: &str = include_str!("fixtures/original-a850/CanCreative.can");
const BOUNDED: &str = include_str!("fixtures/native-count-turn.can");
const EMPTY: &str = "";

struct Original {
    db: SourceDb,
    trees: Vec<(SourceId, SyntaxNode)>,
    resolve: ResolveTables,
    types: TypeTable,
    effects: EffectTables,
}

fn original(chat: &str, creative: &str) -> Original {
    let mut db = SourceDb::new();
    let files = [
        db.add("CanChat.can".into(), chat.into()),
        db.add("CanCreative.can".into(), creative.into()),
    ];
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, errors) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(files[0], 0, 0),
    });
    assert!(errors.is_empty(), "{errors:?}");
    let mut diagnostics = Vec::new();
    let trees = files
        .into_iter()
        .map(|file| {
            let (tree, errors) = syntax::parse(&db, file);
            diagnostics.extend(errors);
            (file, tree)
        })
        .collect::<Vec<_>>();
    let resolve = resolve::resolve_program(&db, &trees, catalog.as_ref(), &mut diagnostics);
    let types = types::check_types(&db, &trees, catalog.as_ref(), &resolve, &mut diagnostics);
    resolve::emit_unresolved(&db, &resolve, &types, &mut diagnostics);
    let effects = check_effects(
        &db,
        &trees,
        &resolve,
        &types,
        catalog.as_ref(),
        &mut diagnostics,
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    Original {
        db,
        trees,
        resolve,
        types,
        effects,
    }
}

impl Original {
    fn inventory(&self) -> HashMap<SymbolId, ScenarioDisclosure> {
        analyze_scenario_disclosure(
            &self.db,
            &self.trees,
            &self.resolve,
            &self.types,
            &self.effects,
        )
    }

    fn symbol(&self, canonical: &str) -> SymbolId {
        self.resolve.by_canonical[canonical]
    }
}

fn text(db: &SourceDb, key: NodeKey) -> &str {
    db.get(key.file).unwrap().text[key.start as usize..key.end as usize].trim()
}

fn counts(
    disclosures: &HashMap<SymbolId, ScenarioDisclosure>,
    owner: SymbolId,
) -> Vec<&DisclosureQuery> {
    disclosures[&owner]
        .source_facts()
        .unwrap()
        .queries
        .as_ref()
        .expect("complete original query source inventory")
        .iter()
        .filter(|query| query.count.is_some())
        .collect()
}

fn assert_missing(
    disclosures: &HashMap<SymbolId, ScenarioDisclosure>,
    owner: SymbolId,
    call: NodeKey,
) {
    assert!(
        disclosures[&owner]
            .source_facts()
            .unwrap()
            .queries
            .as_ref()
            .is_none_or(|queries| {
                queries
                    .iter()
                    .all(|query| query.count.as_ref().is_none_or(|fact| fact.call != call))
            }),
        "mutated count acquired original source inventory"
    );
}

#[test]
fn contained_count_flows_once_into_created_result_without_native_authority() {
    let original = original(BOUNDED, EMPTY);
    let disclosures = original.inventory();
    let owner = original.symbol("CountSources.append");
    let ScenarioDisclosure::Complete(complete) = &disclosures[&owner] else {
        panic!(
            "bounded contained count source declined: {:?}",
            disclosures[&owner]
        );
    };
    let retained = counts(&disclosures, owner);
    assert_eq!(retained.len(), 1);
    let query = retained[0];
    let count = query.count.as_ref().unwrap();
    assert_eq!(text(&original.db, count.call), "count(branch.Turn)");
    assert!(query.dependencies.is_empty());
    assert_eq!(complete.returns.len(), 1);
    let returned = &complete.returns[0];
    assert_eq!(returned.node, query.return_node);
    assert_eq!(returned.influences, query.influences);
    assert!(
        returned.dependencies.is_empty(),
        "parent is genuine metadata, not a fake field read"
    );
    assert_eq!(
        complete.source_facts.as_ref().unwrap().result,
        Some(ResolvedType::Record {
            symbol: original.symbol("CountSources.Turn"),
            stored: true
        })
    );
    assert_eq!(returned.influences.len(), 4);
    assert!(
        complete
            .effects
            .iter()
            .any(|effect| effect.node == count.statement)
    );
}

#[test]
fn copied_or_derived_count_parent_does_not_acquire_direct_query_provenance() {
    for changed in [
        BOUNDED
            .replace("   create Turn", "   let copy=branch\n   create Turn")
            .replace("count(branch.Turn)", "count(copy.Turn)"),
        BOUNDED
            .replace(
                " policy Conversation",
                " derive next(branch:Branch):int=count(branch.Turn)+1\n policy Conversation",
            )
            .replace("position=count(branch.Turn)+1", "position=next(branch)"),
    ] {
        let original = original(&changed, EMPTY);
        let disclosures = original.inventory();
        assert!(
            matches!(
                disclosures[&original.symbol("CountSources.append")],
                ScenarioDisclosure::Declined(_)
            ),
            "copied or derive-local model count acquired direct query provenance"
        );
    }
    let pure = BOUNDED.replace("count(branch.Turn)", "count([1,2])");
    let original = original(&pure, EMPTY);
    let disclosures = original.inventory();
    // Generic supplied-array count keeps its existing executable disclosure
    // boundary. It must not acquire model-query provenance from this hook.
    assert!(matches!(
        disclosures[&original.symbol("CountSources.append")],
        ScenarioDisclosure::Declined(_)
    ));
    assert!(counts(&disclosures, original.symbol("CountSources.append")).is_empty());
}

#[test]
fn byte_exact_original_counts_coexist_with_first_and_keep_real_parent_occurrences() {
    let original = original(CHAT, CREATIVE);
    let disclosures = original.inventory();
    let ask = original.symbol("chat.ask");
    let validate = original.symbol("creative.validate");
    let chat = counts(&disclosures, ask);
    let creative = counts(&disclosures, validate);
    assert_eq!(chat.len(), 2);
    assert_eq!(creative.len(), 1);
    let all = disclosures[&ask]
        .source_facts()
        .unwrap()
        .queries
        .as_ref()
        .unwrap();
    assert_eq!(
        all.len(),
        3,
        "pure arrays, transcript and examples are separate"
    );
    assert!(all[0].count.is_some());
    assert!(all[1].first.is_some());
    assert!(all[2].count.is_some());
    for query in chat.iter().chain(&creative) {
        let fact = query.count.as_ref().unwrap();
        let selected = &original.types.selected_calls[&fact.call];
        assert_eq!(fact.slots, vec![Some(0)]);
        assert_eq!(selected.slots, fact.slots);
        assert!(matches!(&selected.target,
            canlang_compiler::analysis::types::SelectedCallTarget::Builtin { id, overload }
            if id == "count" && *overload == fact.overload));
        assert_eq!(
            original.types.node_types[&fact.call],
            ResolvedType::Scalar(Scalar::Int)
        );
        assert_eq!(
            query.source.sha256,
            sha256_hex(original.db.get(query.node.file).unwrap().text.as_bytes())
        );
        assert!(fact.statement.start <= fact.call.start && fact.call.end <= fact.statement.end);
        assert_eq!(query.limit, None);
        assert!(query.order.is_empty() && query.projection.is_none() && query.first.is_none());
        assert!(
            query
                .influences
                .iter()
                .all(|influence| influence.query_id.as_ref() == Some(&query.id))
        );
    }
    let unscoped = chat[0];
    assert_eq!(unscoped.model_name, "chat.Run");
    assert_eq!(text(&original.db, unscoped.domain), "Run");
    assert_eq!(
        text(&original.db, unscoped.predicate.unwrap()),
        "run.parent.parent==branch.parent and run.unfinished"
    );
    assert!(unscoped.alias.is_some());
    let fact = unscoped.count.as_ref().unwrap();
    assert_eq!(
        text(&original.db, fact.call),
        "count(Run as run where run.parent.parent==branch.parent and run.unfinished)"
    );
    assert_eq!(
        text(&original.db, fact.statement),
        "require count(Run as run where run.parent.parent==branch.parent and run.unfinished)<10"
    );
    assert!(
        fact.contained_parent.is_none(),
        "all Run candidates remain unscoped"
    );
    assert_eq!(
        fact.parent_edges
            .iter()
            .map(|edge| text(&original.db, edge.node))
            .collect::<Vec<_>>(),
        vec!["run.parent", "run.parent.parent", "branch.parent"]
    );
    for (edge, (child, parent)) in fact.parent_edges.iter().zip([
        ("chat.Run", "chat.Branch"),
        ("chat.Branch", "chat.Conversation"),
        ("chat.Branch", "chat.Conversation"),
    ]) {
        assert_eq!(
            original.resolve.symbols[edge.child.0 as usize].canonical,
            child
        );
        assert_eq!(
            original.resolve.symbols[edge.parent.0 as usize].canonical,
            parent
        );
        assert_eq!(
            original.effects.models[&edge.child].owner,
            ModelOwner::ChildOf(edge.parent)
        );
        assert_eq!(
            original.types.node_types[&edge.receiver],
            ResolvedType::Record {
                symbol: edge.child,
                stored: true
            }
        );
        assert_eq!(
            original.types.node_types[&edge.node],
            ResolvedType::Record {
                symbol: edge.parent,
                stored: true
            }
        );
    }
    assert_eq!(unscoped.dependencies.len(), 1);
    assert_eq!(unscoped.dependencies[0].field_name, "unfinished");
    assert_eq!(unscoped.dependencies[0].role, DependencyRole::Control);
    assert!(
        unscoped
            .dependencies
            .iter()
            .all(|dependency| dependency.field_name != "parent")
    );
    for (query, model, operand, parameter) in [
        (chat[1], "chat.Turn", "branch.Turn", "chat.ask.branch"),
        (
            creative[0],
            "creative.Revision",
            "template.Revision",
            "creative.validate.template",
        ),
    ] {
        assert_eq!(query.model_name, model);
        assert_eq!(text(&original.db, query.node), operand);
        assert_eq!(query.domain, query.node);
        assert!(query.alias.is_none() && query.predicate.is_none());
        assert!(query.dependencies.is_empty());
        let fact = query.count.as_ref().unwrap();
        let (receiver, id) = fact.contained_parent.unwrap();
        assert_eq!(original.resolve.symbols[id.0 as usize].canonical, parameter);
        assert_eq!(query.inputs, vec![(receiver, id)]);
        assert!(fact.parent_edges.is_empty());
        assert!(text(&original.db, fact.statement).starts_with("create "));
        assert!(text(&original.db, fact.statement).contains(&format!("count({operand})+1")));
    }
    assert!(matches!(disclosures[&ask], ScenarioDisclosure::Declined(_)));
    assert!(matches!(
        disclosures[&validate],
        ScenarioDisclosure::Declined(_)
    ));
}

#[test]
fn same_spelling_types_model_ownership_and_source_mismatches_refuse_original_counts() {
    let original = original(CHAT, CREATIVE);
    let disclosures = original.inventory();
    let owner = original.symbol("chat.ask");
    let queries = counts(&disclosures, owner);
    let global = queries[0];
    let contained = queries[1];
    for mutation in 0..7 {
        let mut resolve = original.resolve.clone();
        let mut types = original.types.clone();
        let mut effects = original.effects.clone();
        let call = if mutation <= 3 {
            global.count.as_ref().unwrap().call
        } else {
            contained.count.as_ref().unwrap().call
        };
        match mutation {
            0 => {
                types.checked_collection_calls.get_mut(&call).unwrap().model =
                    original.symbol("creative.Run");
            }
            1 => {
                types.selected_calls.get_mut(&call).unwrap().slots[0] = None;
            }
            2 => {
                types.node_types.insert(
                    global.count.as_ref().unwrap().parent_edges[0].node,
                    ResolvedType::Record {
                        symbol: original.symbol("chat.Conversation"),
                        stored: true,
                    },
                );
            }
            3 => {
                types.checked_queries.get_mut(&global.node).unwrap().domain = contained.node;
            }
            4 => {
                types.node_types.insert(
                    contained.node,
                    ResolvedType::Array {
                        element: Box::new(ResolvedType::Record {
                            symbol: original.symbol("chat.Run"),
                            stored: true,
                        }),
                        ordered: true,
                        nonempty: false,
                    },
                );
            }
            5 => {
                let child = original.symbol("chat.Turn");
                let parent = original.symbol("chat.Conversation");
                let SymbolKind::Model { owner, .. } = &mut resolve.symbols[child.0 as usize].kind
                else {
                    panic!()
                };
                *owner = ModelOwner::ChildOf(parent);
                effects.models.get_mut(&child).unwrap().owner = ModelOwner::ChildOf(parent);
            }
            6 => {
                effects
                    .models
                    .get_mut(&original.symbol("chat.Turn"))
                    .unwrap()
                    .fields
                    .reverse();
            }
            _ => unreachable!(),
        }
        let changed =
            analyze_scenario_disclosure(&original.db, &original.trees, &resolve, &types, &effects);
        assert_missing(&changed, owner, call);
    }
    let mut changed_db = SourceDb::new();
    changed_db.add(
        "CanChat.can".into(),
        CHAT.replace("export Turn in Branch", "export Task in Branch"),
    );
    changed_db.add("CanCreative.can".into(), CREATIVE.into());
    let changed = analyze_scenario_disclosure(
        &changed_db,
        &original.trees,
        &original.resolve,
        &original.types,
        &original.effects,
    );
    assert_missing(&changed, owner, contained.count.as_ref().unwrap().call);
}

#[test]
fn scoped_or_shortened_candidate_predicates_and_business_collections_are_not_original_scans() {
    for changed in [
        CHAT.replace("count(Run as run where", "count(branch.Run as run where"),
        CHAT.replace("run.parent.parent==branch.parent", "run.parent==branch"),
        CHAT.replace(
            "run.parent.parent==branch.parent and run.unfinished",
            "run.parent.parent==branch.parent or run.unfinished",
        ),
    ] {
        let original = original(&changed, CREATIVE);
        let disclosures = original.inventory();
        let owner = original.symbol("chat.ask");
        assert!(
            disclosures[&owner]
                .source_facts()
                .unwrap()
                .queries
                .is_none(),
            "altered query gained original scan inventory"
        );
        assert!(matches!(
            disclosures[&owner],
            ScenarioDisclosure::Declined(_)
        ));
    }
    let changed = CHAT.replace(
        "export Branch in Conversation { title:text",
        "export Branch in Conversation { Turn:Turn[], title:text",
    );
    let original = original(&changed, CREATIVE);
    let disclosures = original.inventory();
    let owner = original.symbol("chat.ask");
    assert!(
        counts(&disclosures, owner).iter().all(|query| text(
            &original.db,
            query.count.as_ref().unwrap().call
        ) != "count(branch.Turn)"),
        "authored business field array acquired implicit containment provenance"
    );
    assert!(matches!(
        disclosures[&owner],
        ScenarioDisclosure::Declined(_)
    ));
}
