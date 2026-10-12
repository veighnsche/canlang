//! Original inline WHERE-bound TextMessage selection source facts only.
//! Candidate/File/native authority and completion of other regenerate leaves are separate.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::effects::{EffectTables, check_effects};
use canlang_compiler::analysis::resolve::{self, Binding, ModelOwner, SymbolKind};
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, DisclosureQuery, InfluenceKind, ScenarioDisclosure, analyze_scenario_disclosure,
};
use canlang_compiler::analysis::{
    NodeKey, ResolveTables, ResolvedType, Scalar, SymbolId, TypeTable, types,
};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::syntax::{self, SyntaxNode};
use std::{collections::HashMap, path::Path};

const CHAT: &str = include_str!("fixtures/original-a850/CanChat.can");
const CREATIVE: &str = include_str!("fixtures/original-a850/CanCreative.can");
const ORIGINAL: &str = "turn.parent.Turn as prior where prior.position<turn.position order=prior.position select TextMessage {role=prior.role,content=prior.content,attachments=prior.attachments}";
struct Original {
    db: SourceDb,
    trees: Vec<(SourceId, SyntaxNode)>,
    resolve: ResolveTables,
    types: TypeTable,
    effects: EffectTables,
}
impl Original {
    fn new() -> Self {
        Self::from_sources(CHAT, CREATIVE)
    }
    fn from_sources(chat: &str, creative: &str) -> Self {
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
        Self {
            db,
            trees,
            resolve,
            types,
            effects,
        }
    }
    fn inventory(&self) -> HashMap<SymbolId, ScenarioDisclosure> {
        analyze_scenario_disclosure(
            &self.db,
            &self.trees,
            &self.resolve,
            &self.types,
            &self.effects,
        )
    }
    fn symbol(&self, name: &str) -> SymbolId {
        self.resolve.by_canonical[name]
    }
    fn query(&self) -> NodeKey {
        *self
            .types
            .checked_queries
            .keys()
            .find(|key| text(&self.db, **key) == ORIGINAL)
            .unwrap()
    }
}
fn text(db: &SourceDb, key: NodeKey) -> &str {
    db.get(key.file).unwrap().text[key.start as usize..key.end as usize].trim()
}
fn exact(
    source: &HashMap<SymbolId, ScenarioDisclosure>,
    owner: SymbolId,
    node: NodeKey,
) -> Option<&DisclosureQuery> {
    source[&owner]
        .source_facts()?
        .queries
        .as_ref()?
        .iter()
        .find(|query| query.node == node)
}
fn message_array(ty: &ResolvedType) {
    let ResolvedType::Array {
        element,
        ordered: true,
        nonempty: false,
    } = ty
    else {
        panic!("original ordered array")
    };
    let ResolvedType::StdNominal { name, fields } = element.as_ref() else {
        panic!("catalog nominal identity")
    };
    assert_eq!(*name, "TextMessage");
    assert_eq!(
        fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["role", "content", "attachments"]
    );
    assert_eq!(
        fields[0].1,
        ResolvedType::Enum {
            owner: None,
            cases: vec!["system".into(), "user".into(), "assistant".into()]
        }
    );
    assert_eq!(fields[1].1, ResolvedType::Scalar(Scalar::Text));
    assert_eq!(
        fields[2].1,
        ResolvedType::Array {
            element: Box::new(ResolvedType::Scalar(Scalar::File)),
            ordered: true,
            nonempty: false
        }
    );
}

#[test]
fn byte_exact_regenerate_retains_where_bound_inline_selection_separately_from_transcript() {
    assert!(CHAT.contains("let prefix=turn.parent.prefix+("));
    assert!(CHAT.contains(ORIGINAL));
    let original = Original::new();
    let owner = original.symbol("chat.regenerate");
    let node = original.query();
    let disclosures = original.inventory();
    let query = exact(&disclosures, owner, node).expect("exact original inline source inventory");
    let checked = &original.types.checked_queries[&node];
    let model = original.symbol("chat.Turn");
    let branch = original.symbol("chat.Branch");
    let parameter = original.effects.scenarios[&owner]
        .params
        .iter()
        .find(|param| original.resolve.symbols[param.param.0 as usize].name == "turn")
        .unwrap()
        .param;
    assert_eq!(query.model, model);
    assert_eq!(query.model_name, "chat.Turn");
    assert_eq!(text(&original.db, query.domain), "turn.parent.Turn");
    assert_eq!(query.alias, Some(checked.clauses[0].node));
    assert_eq!(text(&original.db, query.alias.unwrap()), "as prior");
    assert_eq!(
        text(&original.db, query.predicate.unwrap()),
        "prior.position<turn.position"
    );
    assert!(query.projection.is_none() && query.first.is_none() && query.count.is_none());
    assert!(
        checked.projection.is_none(),
        "TextMessage has no invented local Contract ID"
    );
    message_array(&checked.result);
    assert_eq!(query.inputs.len(), 1);
    assert_eq!(query.inputs[0].1, parameter);
    assert_eq!(text(&original.db, query.inputs[0].0), "turn");
    assert!(
        matches!(original.resolve.node_binding.get(&query.inputs[0].0),Some(Binding::Symbol(id)) if *id==parameter)
    );
    assert!(
        matches!(original.resolve.symbols[model.0 as usize].kind,SymbolKind::Model {owner:ModelOwner::ChildOf(parent),..} if parent==branch)
    );
    assert_eq!(query.order.len(), 1);
    assert_eq!(
        query.order[0].field,
        Some(original.symbol("chat.Turn.position"))
    );
    assert_eq!(text(&original.db, query.order[0].node), "prior.position");
    assert!(!query.order[0].descending);
    assert!(!query.archived && query.limit.is_none());
    assert_eq!(text(&original.db, query.return_node), "return run");
    assert_eq!(
        query
            .dependencies
            .iter()
            .map(|dependency| dependency.field_name.as_str())
            .collect::<Vec<_>>(),
        ["position", "position", "role", "content", "attachments"]
    );
    assert_eq!(
        query
            .dependencies
            .iter()
            .map(|dependency| dependency.role)
            .collect::<Vec<_>>(),
        [
            DependencyRole::Control,
            DependencyRole::Control,
            DependencyRole::Data,
            DependencyRole::Data,
            DependencyRole::Data
        ]
    );
    assert_ne!(query.dependencies[0].node, query.dependencies[1].node);
    assert_eq!(
        query
            .dependencies
            .iter()
            .map(|dependency| dependency.id.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        5
    );
    for dependency in &query.dependencies {
        assert_eq!(dependency.model, model);
        assert!(dependency.calls.is_empty() && dependency.query_id.is_none());
        assert_eq!(dependency.source, query.source);
        assert_eq!(original.types.node_types[&dependency.node], dependency.ty);
    }
    assert_eq!(text(&original.db, query.dependencies[2].node), "prior.role");
    assert_eq!(
        text(&original.db, query.dependencies[3].node),
        "prior.content"
    );
    assert_eq!(
        text(&original.db, query.dependencies[4].node),
        "prior.attachments"
    );
    assert_eq!(
        query.dependencies[4].field,
        original.symbol("chat.Turn.attachments")
    );
    assert_eq!(query.dependencies[4].type_id, "file[]");
    assert_eq!(
        query
            .influences
            .iter()
            .map(|influence| influence.kind)
            .collect::<Vec<_>>(),
        [
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder
        ]
    );
    assert!(
        query
            .influences
            .iter()
            .all(|influence| influence.query_id.as_deref() == Some(query.id.as_str()))
    );
    let ask = original.symbol("chat.ask");
    assert!(
        disclosures[&ask]
            .source_facts()
            .unwrap()
            .queries
            .as_ref()
            .unwrap()
            .iter()
            .all(|query| query.node != node),
        "direct WHERE-bound selection belongs to regenerate, not either transcript caller"
    );
    // Whole original source may still decline another guarded/reference/CALL leaf.
    // An inventory cannot establish native execution or application acceptance.
}

#[test]
fn inline_selection_follows_renamed_declarations_and_the_actual_order_field() {
    let source = CHAT
        .replace("Branch", "Stream")
        .replace("Turn", "Entry")
        .replace("Profile", "Settings")
        .replace("Run", "Job")
        .replace("TextJob", "TextRun")
        .replace("prefix", "seed_messages")
        .replace("position", "sequence")
        .replace("as prior", "as previous")
        .replace("prior.", "previous.")
        .replace("max=120", "max=96")
        .replace("<120", "<96");
    let creative = CREATIVE
        .replace("Branch", "Stream")
        .replace("Turn", "Entry")
        .replace("Profile", "Settings")
        .replace("Run", "Job")
        .replace("ImageJob", "ImageRun")
        .replace(
            "list row.Entry order=position",
            "list row.Entry order=sequence",
        );
    let own = Original::from_sources(&source, &creative);
    let owner = own.symbol("chat.regenerate");
    let inventory = own.inventory();
    let expected = ORIGINAL
        .replace("prefix", "seed_messages")
        .replace("Turn", "Entry")
        .replace("position", "sequence")
        .replace("as prior", "as previous")
        .replace("prior.", "previous.");
    let node = *own
        .types
        .checked_queries
        .keys()
        .find(|key| text(&own.db, **key) == expected)
        .unwrap();
    let query = exact(&inventory, owner, node).expect("genuine renamed inline declaration");
    assert_eq!(query.model, own.symbol("chat.Entry"));
    assert_eq!(
        query.order[0].field,
        Some(own.symbol("chat.Entry.sequence"))
    );
    assert!(
        query
            .dependencies
            .iter()
            .any(|read| read.field_name == "sequence")
    );
    assert_eq!(query.dependencies.len(), 5);
    assert_eq!(query.influences.len(), 4);
}

#[test]
fn mutated_inline_query_type_owner_alias_bound_field_or_clause_withdraws_original_inventory() {
    let original = Original::new();
    let owner = original.symbol("chat.regenerate");
    let node = original.query();
    let baseline = original.inventory();
    assert!(exact(&baseline, owner, node).is_some());
    for mutation in 0..9 {
        let mut types = original.types.clone();
        let mut resolve = original.resolve.clone();
        let mut effects = original.effects.clone();
        let query = types.checked_queries.get_mut(&node).unwrap();
        match mutation {
            0 => query.clauses.swap(1, 2),
            1 => {
                query.domain_type = ResolvedType::Array {
                    element: Box::new(ResolvedType::Record {
                        symbol: original.symbol("chat.Branch"),
                        stored: true,
                    }),
                    ordered: true,
                    nonempty: false,
                }
            }
            2 => {
                query.result = ResolvedType::Array {
                    element: Box::new(ResolvedType::Object(vec![])),
                    ordered: true,
                    nonempty: false,
                }
            }
            3 => {
                let bound = types
                    .node_types
                    .keys()
                    .copied()
                    .find(|key| {
                        key.start > node.start
                            && key.end < node.end
                            && text(&original.db, *key) == "turn.position"
                    })
                    .unwrap();
                types
                    .node_types
                    .insert(bound, ResolvedType::Scalar(Scalar::Text));
            }
            4 => {
                let alias = query.clauses[0].node;
                let bound = types
                    .node_types
                    .keys()
                    .copied()
                    .find(|key| {
                        key.start > node.start
                            && key.end < node.end
                            && text(&original.db, *key) == "turn"
                    })
                    .unwrap();
                resolve
                    .node_binding
                    .insert(bound, Binding::QueryAlias { node: alias });
            }
            5 => {
                let field = original.symbol("chat.Turn.attachments");
                types.symbol_types.insert(
                    field,
                    ResolvedType::Array {
                        element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                        ordered: true,
                        nonempty: false,
                    },
                );
            }
            6 => {
                let field = original.symbol("chat.Turn.content");
                let SymbolKind::Field { owner, .. } = &mut resolve.symbols[field.0 as usize].kind
                else {
                    panic!()
                };
                *owner = original.symbol("chat.Branch");
            }
            7 => {
                effects
                    .models
                    .get_mut(&original.symbol("chat.Turn"))
                    .unwrap()
                    .owner = ModelOwner::ChildOf(original.symbol("chat.Conversation"))
            }
            8 => {
                let branch = effects
                    .models
                    .get_mut(&original.symbol("chat.Branch"))
                    .unwrap();
                let prefix = branch
                    .fields
                    .iter_mut()
                    .find(|field| field.field == original.symbol("chat.Branch.prefix"))
                    .unwrap();
                prefix.required_array = true;
            }
            _ => unreachable!(),
        }
        let changed =
            analyze_scenario_disclosure(&original.db, &original.trees, &resolve, &types, &effects);
        assert!(
            exact(&changed, owner, node).is_none(),
            "mutant {mutation} borrowed original inline selection proof"
        );
    }
    let mut stale_db = SourceDb::new();
    stale_db.add(
        "CanChat.can".into(),
        CHAT.replace(
            "prior.position<turn.position",
            "prior.position>turn.position",
        ),
    );
    stale_db.add("CanCreative.can".into(), CREATIVE.into());
    let changed = analyze_scenario_disclosure(
        &stale_db,
        &original.trees,
        &original.resolve,
        &original.types,
        &original.effects,
    );
    assert!(
        exact(&changed, owner, node).is_none(),
        "same-span stale predicate spelling borrowed original bound"
    );
}
