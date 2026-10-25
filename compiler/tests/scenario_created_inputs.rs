//! Exact source preparation for scenario-owned populated creates. These facts
//! neither issue a row nor qualify the original query/SEND/native workflow.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::effects::{EffectTables, EffectVerb, check_effects};
use canlang_compiler::analysis::resolve::{self, ModelOwner};
use canlang_compiler::analysis::scenario_disclosure::{
    DisclosureEffectKind, ScenarioDisclosure, analyze_scenario_disclosure,
};
use canlang_compiler::analysis::{
    ResolveTables, ResolvedType, Scalar, SymbolId, TypeTable, check_program, types,
};
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::syntax::{self, SyntaxNode};
use std::path::Path;

// Retain creator attribution, containment, omitted server/default/nullable
// fields, bounds, rules and exact authored input order. No public CRUD exists.
const POPULATED: &str = r#"app CreatedInputs
Given
 Parent {title:text}
 Other {title:text}
 Record in Parent {title:text trim max=200,account:user server=actor,payload:file[] max=8,owner:Parent?,count:int=0}
 policy Parent read=members
 policy Other read=members
 policy Record read=members
 invariant Record: row.count>=0
 unique Record fields=title
 lock Record fields=title,account
When
 scenario make(parent:Parent,title:text,payload:file[],owner:Parent?=null) by=members -> Record
  do
   require true
   let caption=title
   create Record {parent,title=caption,payload,owner} as record
   return record
Then
"#;

fn catalog(db: &SourceDb, file: SourceId) -> Catalog {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(db.get(file).is_some());
    catalog.unwrap()
}

fn raw(
    source: &str,
) -> (
    SourceDb,
    Vec<(SourceId, SyntaxNode)>,
    ResolveTables,
    TypeTable,
    EffectTables,
) {
    let mut db = SourceDb::new();
    let file = db.add("scenario-created-inputs.can".into(), source.into());
    let catalog = catalog(&db, file);
    let (tree, mut diagnostics) = syntax::parse(&db, file);
    let trees = vec![(file, tree)];
    let resolve = resolve::resolve_program(&db, &trees, Some(&catalog), &mut diagnostics);
    let types = types::check_types(&db, &trees, Some(&catalog), &resolve, &mut diagnostics);
    resolve::emit_unresolved(&db, &resolve, &types, &mut diagnostics);
    let effects = check_effects(
        &db,
        &trees,
        &resolve,
        &types,
        Some(&catalog),
        &mut diagnostics,
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, trees, resolve, types, effects)
}

fn id(resolve: &ResolveTables, canonical: &str) -> SymbolId {
    *resolve.by_canonical.get(canonical).unwrap()
}

#[test]
fn original_chat_and_creative_create_sites_keep_full_owning_schema_and_authored_order() {
    // Their create declarations/sites are unchanged in these owning drafts;
    // later callback/UI additions in the frozen original are separate scope.
    let mut db = SourceDb::new();
    let chat = db.add(
        "CanChat.can".into(),
        include_str!("../../draft/apps/CanChat/CanChat.can").into(),
    );
    let creative = db.add(
        "CanCreative.can".into(),
        include_str!("../../draft/apps/CanCreative/CanCreative.can").into(),
    );
    let catalog = catalog(&db, chat);
    // Inspect only the original constructor/schema criteria, without admitting
    // a CheckedProgram or emitting from an unrelated erroneous draft body.
    let mut diagnostics = Vec::new();
    let trees: Vec<_> = [chat, creative]
        .into_iter()
        .map(|file| {
            let (tree, errors) = syntax::parse(&db, file);
            diagnostics.extend(errors);
            (file, tree)
        })
        .collect();
    let resolve = resolve::resolve_program(&db, &trees, Some(&catalog), &mut diagnostics);
    let types = types::check_types(&db, &trees, Some(&catalog), &resolve, &mut diagnostics);
    resolve::emit_unresolved(&db, &resolve, &types, &mut diagnostics);
    let effects = check_effects(
        &db,
        &trees,
        &resolve,
        &types,
        Some(&catalog),
        &mut diagnostics,
    );
    let disclosures = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
    for (canonical, expected) in [
        (
            "chat.ask",
            vec![
                (
                    "chat.Run",
                    vec![
                        "parent",
                        "account",
                        "allowance",
                        "request_value",
                        "reserved",
                    ],
                ),
                (
                    "chat.Turn",
                    vec![
                        "parent",
                        "position",
                        "role",
                        "content",
                        "attachments",
                        "run",
                    ],
                ),
            ],
        ),
        (
            "chat.regenerate",
            vec![(
                "chat.Branch",
                vec!["parent", "title", "profile", "prefix", "origin"],
            )],
        ),
        (
            "creative.generate",
            vec![(
                "creative.Run",
                vec![
                    "source",
                    "conversation",
                    "revision",
                    "budget",
                    "prompt",
                    "negative",
                    "width",
                    "height",
                ],
            )],
        ),
    ] {
        let owner = resolve
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == canonical)
            .unwrap();
        let disclosure = &disclosures[&owner.id];
        assert!(
            matches!(disclosure, ScenarioDisclosure::Declined(_)),
            "original unresolved query/child leaf must remain visible"
        );
        let source = disclosure.source_facts().expect("checked original source");
        let creates = source
            .creates
            .as_ref()
            .unwrap_or_else(|| panic!("{canonical}: complete original create inventory"));
        assert_eq!(creates.len(), expected.len(), "{canonical}");
        for (created, (model, names)) in creates.iter().zip(expected) {
            // Other draft edits (including SEND validation narrowing) do not
            // qualify this source-only inventory. Errors at the selected
            // constructor or its owning model still invalidate this criterion.
            for node in [created.node, created.definition.declaration.node] {
                assert!(
                    diagnostics
                        .iter()
                        .all(|diagnostic| diagnostic.primary.file != node.file
                            || diagnostic.primary.end <= node.start
                            || diagnostic.primary.start >= node.end),
                    "selected create/model has diagnostics: {diagnostics:?}"
                );
            }
            assert_eq!(created.definition.canonical, model);
            assert_eq!(
                created
                    .inputs
                    .iter()
                    .map(|input| input.name.as_str())
                    .collect::<Vec<_>>(),
                names
            );
            let declaration = &effects.models[&created.model];
            assert_eq!(created.definition.declaration.fields, declaration.fields);
            assert_eq!(
                created
                    .definition
                    .fields
                    .iter()
                    .map(|field| field.field)
                    .collect::<Vec<_>>(),
                declaration
                    .fields
                    .iter()
                    .map(|field| field.field)
                    .collect::<Vec<_>>()
            );
            assert_eq!(created.definition.declaration.owner, declaration.owner);
            assert_eq!(
                created.definition.declaration.invariants.len(),
                declaration.invariants.len()
            );
            assert_eq!(
                created.definition.declaration.uniques.len(),
                declaration.uniques.len()
            );
            assert_eq!(
                created.definition.declaration.locks.len(),
                declaration.locks.len()
            );
            assert_eq!(
                created.definition.declaration.retains.len(),
                declaration.retains.len()
            );
            for field in &created.definition.fields {
                assert_eq!(&field.ty, &types.symbol_types[&field.field]);
                assert_eq!(field.source, created.definition.source);
            }
            for input in &created.inputs {
                assert_eq!(&input.ty, &types.node_types[&input.value_node]);
                assert_eq!(input.key_node.file, created.node.file);
                assert!(
                    input.key_node.start > created.node.start
                        && input.value_node.end < created.node.end
                );
                if input.name == "parent" {
                    assert_eq!(input.field, None);
                    let ModelOwner::ChildOf(parent) = declaration.owner else {
                        panic!("contained model");
                    };
                    assert_eq!(
                        input.ty,
                        ResolvedType::Record {
                            symbol: parent,
                            stored: true
                        }
                    );
                } else {
                    let field = &resolve.symbols[input.field.unwrap().0 as usize];
                    assert_eq!(field.name, input.name);
                }
            }
            let text = &db.get(created.node.file).unwrap().text;
            let actual = text[created.node.start as usize..created.node.end as usize].trim();
            assert!(actual.starts_with("create "));
            assert!(actual.ends_with(&format!("as {}", created.binding)));
        }
    }
    let run = resolve
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "creative.Run")
        .unwrap();
    let declaration = &effects.models[&run.id];
    assert!(
        declaration
            .fields
            .iter()
            .any(
                |field| resolve.symbols[field.field.0 as usize].name == "author"
                    && field.server.is_some()
            )
    );
    assert!(
        declaration
            .fields
            .iter()
            .any(
                |field| resolve.symbols[field.field.0 as usize].name == "unfinished"
                    && field.default.is_some()
            )
    );
}

#[test]
fn populated_contained_create_returns_its_direct_origin_without_public_crud() {
    let (db, trees, resolve, types, effects) = raw(POPULATED);
    let owner = id(&resolve, "CreatedInputs.make");
    let plans = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
    let ScenarioDisclosure::Complete(plan) = &plans[&owner] else {
        panic!("complete narrow source producer: {:?}", plans[&owner]);
    };
    let [proof] = plan.effects.as_slice() else {
        panic!("one create");
    };
    let DisclosureEffectKind::Create {
        model,
        crud,
        binding,
        inputs,
        defaults,
    } = &proof.kind
    else {
        panic!("create");
    };
    assert_eq!(*model, id(&resolve, "CreatedInputs.Record"));
    assert_eq!(*crud, None);
    assert_eq!(binding, "record");
    assert!(
        defaults.is_empty(),
        "server/defaults remain native-owned authored declarations"
    );
    assert_eq!(
        inputs
            .iter()
            .map(|input| input.name.as_str())
            .collect::<Vec<_>>(),
        ["parent", "title", "payload", "owner"]
    );
    let source = plan.source_facts.as_ref().unwrap();
    assert_eq!(source.creates.as_ref().unwrap()[0].inputs, *inputs);
    assert!(
        plan.returns
            .iter()
            .all(|returned| returned.influences.is_empty())
    );
    assert!(plan.returns.iter().all(|returned| returned.intrinsics.iter().any(|input| matches!(input.kind, canlang_compiler::analysis::scenario_disclosure::DisclosureIntrinsicKind::AdmittedInput {parameter_name: ref name, ..} if name == "title"))));
    // Staged scalar reads retain the original constructor provenance, while
    // copied row carriers and a different returned model remain unproved.
    for (case, source) in [
        POPULATED.replace("return record", "let copied=record\n   return copied"),
        POPULATED
            .replace("-> Record", "-> Parent")
            .replace("return record", "return parent"),
        POPULATED
            .replace("-> Record", "-> text")
            .replace("return record", "return record.title"),
    ]
    .into_iter()
    .enumerate()
    {
        let (db, trees, resolve, types, effects) = raw(&source);
        let plans = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
        if case != 2 {
            assert!(
                matches!(
                    plans[&id(&resolve, "CreatedInputs.make")],
                    ScenarioDisclosure::Declined(_)
                ),
                "unproved row result case {case}"
            );
            continue;
        }
        let ScenarioDisclosure::Complete(proof) = &plans[&id(&resolve, "CreatedInputs.make")]
        else {
            panic!("original staged constructor scalar must complete");
        };
        assert_eq!(
            proof.source.sha256,
            canlang_compiler::source::sha256_hex(source.as_bytes())
        );
        assert_eq!(proof.returns.len(), 1);
        assert_eq!(
            proof
                .source_facts
                .as_ref()
                .unwrap()
                .creates
                .as_ref()
                .unwrap()
                .len(),
            1
        );
        assert!(
            proof.returns[0]
                .dependencies
                .iter()
                .any(|read| read.model_name == "CreatedInputs.Record"
                    && read.field_name == "title"
                    && read.type_id == "text"),
            "the returned original field retains its owning DATA obligation"
        );
    }
}

#[test]
fn create_inventory_refuses_owner_source_field_type_order_parent_default_and_server_mutations() {
    let (db, trees, resolve, types, effects) = raw(POPULATED);
    let owner = id(&resolve, "CreatedInputs.make");
    let model = id(&resolve, "CreatedInputs.Record");
    for mutation in [
        "owner",
        "canonical",
        "source",
        "field",
        "type",
        "order",
        "parent",
        "default",
        "server",
        "rules",
    ] {
        let mut changed_resolve = resolve.clone();
        let mut changed_types = types.clone();
        let mut changed_effects = effects.clone();
        let created = changed_effects
            .scenarios
            .get_mut(&owner)
            .unwrap()
            .effects
            .iter_mut()
            .find(|effect| effect.verb == EffectVerb::Create)
            .unwrap();
        match mutation {
            "owner" => changed_effects.models.get_mut(&model).unwrap().owner = ModelOwner::Team,
            "canonical" => {
                changed_resolve.symbols[model.0 as usize].canonical = "Foreign.Record".into()
            }
            "source" => created.node.end -= 1,
            "field" => created.args[1].key = "account".into(),
            "type" => {
                changed_types.symbol_types.insert(
                    id(&resolve, "CreatedInputs.Record.title"),
                    ResolvedType::Scalar(Scalar::Bool),
                );
            }
            "order" => created.args.swap(1, 2),
            "parent" => {
                changed_types.node_types.insert(
                    created.args[0].key_node,
                    ResolvedType::Record {
                        symbol: id(&resolve, "CreatedInputs.Other"),
                        stored: true,
                    },
                );
            }
            "default" => {
                changed_effects
                    .models
                    .get_mut(&model)
                    .unwrap()
                    .fields
                    .iter_mut()
                    .find(|field| resolve.symbols[field.field.0 as usize].name == "count")
                    .unwrap()
                    .default = None
            }
            "server" => {
                changed_effects
                    .models
                    .get_mut(&model)
                    .unwrap()
                    .fields
                    .iter_mut()
                    .find(|field| resolve.symbols[field.field.0 as usize].name == "account")
                    .unwrap()
                    .server = None
            }
            "rules" => changed_effects
                .models
                .get_mut(&model)
                .unwrap()
                .locks
                .clear(),
            _ => unreachable!(),
        }
        let plans = analyze_scenario_disclosure(
            &db,
            &trees,
            &changed_resolve,
            &changed_types,
            &changed_effects,
        );
        assert!(
            matches!(plans[&owner], ScenarioDisclosure::Declined(_)),
            "{mutation}"
        );
        assert!(
            plans[&owner]
                .source_facts()
                .is_none_or(|source| source.creates.is_none()),
            "{mutation}: forged create inventory"
        );
    }
}

#[test]
fn scenario_create_does_not_enable_delete_without_its_existing_public_crud_profile() {
    let source = POPULATED.replace("let caption=title\n   create Record {parent,title=caption,payload,owner} as record\n   return record", "delete parent").replace(" -> Record", "");
    let (db, trees, resolve, types, effects) = raw(&source);
    let plans = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
    assert!(matches!(
        plans[&id(&resolve, "CreatedInputs.make")],
        ScenarioDisclosure::Declined(_)
    ));
}

fn lowered() -> (SourceDb, ir::IrProgram) {
    lowered_source(POPULATED)
}

fn lowered_source(source: &str) -> (SourceDb, ir::IrProgram) {
    let mut db = SourceDb::new();
    let file = db.add("scenario-created-inputs.can".into(), source.into());
    let catalog = catalog(&db, file);
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, ir)
}

#[test]
fn populated_create_native_source_join_refuses_same_span_operand_and_schema_mutants() {
    let (db, ir) = lowered();
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "CreatedInputs.make")
        .unwrap()
        .id;
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == "CreatedInputs.make")
            .unwrap()
            .disclosure
            .is_some()
    );
    assert!(
        emitted
            .entry
            .js
            .contains("await bindScenarioReceiptModelResult(c,$receiptReturns[0],$receiptValue)")
    );
    assert_eq!(emitted.entry.js.matches("await create(").count(), 1);
    for mode in [
        "operand-name",
        "operand-type",
        "operand-order",
        "operand-missing",
        "prefix-name",
        "prefix-value",
        "prefix-type",
        "prefix-missing",
        "require-value",
        "permission",
        "parameter-name",
        "parameter-index",
        "parameter-default",
        "return-name",
        "result-type",
        "create-binding",
        "scenario-id",
        "model-parent",
        "model-parent-canonical",
        "default-value",
        "server-value",
        "field-modifier",
        "invariant",
    ] {
        let mut changed = ir.clone();
        if mode.starts_with("operand-") {
            let ir::IrItemKind::Scenario { effects, .. } =
                &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario");
            };
            let ir::IrStmt::Create { input, .. } = effects
                .iter_mut()
                .find(|effect| matches!(effect, ir::IrStmt::Create { .. }))
                .unwrap()
            else {
                panic!("create");
            };
            let ir::IrExpr::Object(entries) = &mut input.expr else {
                panic!("object");
            };
            match mode {
                "operand-name" => entries[1].1.expr = ir::IrExpr::Name("payload".into()),
                "operand-type" => entries[1].1.ty = ResolvedType::Scalar(Scalar::Bool),
                "operand-order" => entries.swap(1, 2),
                "operand-missing" => {
                    entries.pop();
                }
                _ => unreachable!(),
            }
        } else if mode.starts_with("prefix-") || matches!(mode, "require-value" | "permission") {
            let ir::IrItemKind::Scenario {
                by,
                guards,
                effects,
                ..
            } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario");
            };
            if mode == "prefix-missing" {
                effects.retain(|effect| !matches!(effect, ir::IrStmt::Let { .. }));
            } else if mode == "permission" {
                *by = vec![ir::IrGuard::Role("public".into())];
            } else if mode == "require-value" {
                let ir::IrStmt::Require { cond, .. } = guards
                    .iter_mut()
                    .chain(effects.iter_mut())
                    .find(|effect| matches!(effect, ir::IrStmt::Require { .. }))
                    .unwrap()
                else {
                    panic!("require");
                };
                cond.expr = ir::IrExpr::Bool(false);
            } else {
                let ir::IrStmt::Let { name, value, .. } = effects
                    .iter_mut()
                    .find(|effect| matches!(effect, ir::IrStmt::Let { .. }))
                    .unwrap()
                else {
                    panic!("let");
                };
                if mode == "prefix-name" {
                    *name = "other".into();
                } else if mode == "prefix-type" {
                    value.ty = ResolvedType::Scalar(Scalar::Int);
                } else {
                    value.expr = ir::IrExpr::Name("parent".into());
                }
            }
        } else if mode == "scenario-id" {
            changed.items[owner.0 as usize].id = ir
                .items
                .iter()
                .find(|item| item.canonical == "CreatedInputs.Parent")
                .unwrap()
                .id;
        } else if matches!(mode, "return-name" | "result-type" | "create-binding") {
            let ir::IrItemKind::Scenario {
                result, effects, ..
            } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario");
            };
            if mode == "result-type" {
                *result = Some(ResolvedType::Scalar(Scalar::Text));
            } else if mode == "create-binding" {
                let ir::IrStmt::Create { binding, .. } = effects
                    .iter_mut()
                    .find(|effect| matches!(effect, ir::IrStmt::Create { .. }))
                    .unwrap()
                else {
                    panic!("create");
                };
                *binding = Some("other".into());
            } else {
                let ir::IrStmt::Return {
                    value: Some(value), ..
                } = effects
                    .iter_mut()
                    .find(|effect| matches!(effect, ir::IrStmt::Return { .. }))
                    .unwrap()
                else {
                    panic!("return");
                };
                value.expr = ir::IrExpr::Name("parent".into());
            }
        } else if mode.starts_with("parameter-") {
            let target = if mode == "parameter-default" {
                "CreatedInputs.make.owner"
            } else {
                "CreatedInputs.make.title"
            };
            let item = changed
                .items
                .iter_mut()
                .find(|item| item.canonical == target)
                .unwrap();
            if mode == "parameter-name" {
                item.name = "other".into();
                item.canonical = "CreatedInputs.make.other".into();
            } else {
                let ir::IrItemKind::Param { index, default, .. } = &mut item.kind else {
                    panic!("parameter");
                };
                if mode == "parameter-index" {
                    *index = 99;
                } else {
                    let Some(ir::IrDefault::Literal(value)) = default else {
                        panic!("default");
                    };
                    value.expr = ir::IrExpr::Name("parent".into());
                }
            }
        } else if mode == "model-parent-canonical" {
            let item = changed
                .items
                .iter_mut()
                .find(|item| item.canonical == "CreatedInputs.Parent")
                .unwrap();
            item.canonical = "Foreign.Parent".into();
        } else {
            let target = match mode {
                "default-value" => "CreatedInputs.Record.count",
                "server-value" => "CreatedInputs.Record.account",
                "field-modifier" => "CreatedInputs.Record.title",
                _ => "CreatedInputs.Record",
            };
            let item = changed
                .items
                .iter_mut()
                .find(|item| item.canonical == target)
                .unwrap();
            match (&mut item.kind, mode) {
                (ir::IrItemKind::Model { owner, .. }, "model-parent") => *owner = ir::IrOwner::Team,
                (
                    ir::IrItemKind::Field {
                        default: Some(ir::IrDefault::Literal(value)),
                        ..
                    },
                    "default-value",
                ) => value.expr = ir::IrExpr::Int(9),
                (ir::IrItemKind::Field { server, .. }, "server-value") => *server = None,
                (ir::IrItemKind::Field { modifiers, .. }, "field-modifier") => {
                    modifiers.trim = false
                }
                (ir::IrItemKind::Model { invariants, .. }, "invariant") => invariants.clear(),
                _ => panic!("{mode}"),
            }
        }
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == "CreatedInputs.make")
                .unwrap()
                .disclosure
                .is_none(),
            "{mode}"
        );
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}"
        );
    }
}

#[test]
fn original_arithmetic_prefix_refuses_same_span_local_and_coordinated_helper_type_corruption() {
    let source = POPULATED
        .replace(
            "let caption=title",
            "let caption=title\n   let left=7\n   let right=3\n   let total=left+right",
        )
        .replace(
            "payload,owner} as record",
            "payload,owner,count=total} as record",
        );
    let (db, ir) = lowered_source(&source);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "CreatedInputs.make")
        .unwrap()
        .id;
    let emitted = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(emitted.diagnostics.is_empty(), "{:?}", emitted.diagnostics);
    assert!(
        emitted
            .operations
            .iter()
            .find(|operation| operation.name == "CreatedInputs.make")
            .unwrap()
            .disclosure
            .is_some()
    );
    assert!(
        emitted.entry.js.contains("int64("),
        "original int arithmetic must retain its integer helper"
    );
    for mode in [
        "local-left-type",
        "local-right-type",
        "coordinated-decimal-helper",
    ] {
        let mut changed = ir.clone();
        let ir::IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
        else {
            panic!("scenario")
        };
        let ir::IrStmt::Let { value, .. } = effects
            .iter_mut()
            .find(|effect| matches!(effect, ir::IrStmt::Let {name, ..} if name == "total"))
            .unwrap()
        else {
            panic!("arithmetic let")
        };
        let ir::IrExpr::Binary { left, right, .. } = &mut value.expr else {
            panic!("arithmetic")
        };
        assert!(matches!(&left.expr, ir::IrExpr::Name(name) if name == "left"));
        assert!(matches!(&right.expr, ir::IrExpr::Name(name) if name == "right"));
        let decimal = ResolvedType::Scalar(Scalar::Decimal);
        match mode {
            "local-left-type" => left.ty = decimal,
            "local-right-type" => right.ty = decimal,
            "coordinated-decimal-helper" => {
                value.ty = decimal.clone();
                left.ty = decimal.clone();
                right.ty = decimal;
            }
            _ => unreachable!(),
        }
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == "CreatedInputs.make")
                .unwrap()
                .disclosure
                .is_none(),
            "{mode}"
        );
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}"
        );
        if mode == "coordinated-decimal-helper" {
            assert!(
                emitted.entry.js.contains("addDecimal("),
                "control must exercise the corrupted helper selection"
            );
        }
    }
}

#[test]
fn actual_cli_installed_descriptor_keeps_containment_defaults_and_source_only_create() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("scenario-created-inputs.can");
    std::fs::write(&source, POPULATED).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(root)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, output.stdout).unwrap();
    let runner = scratch.path().join("created-inputs.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact),factory=module.canApp();
const loaded=loadArtifactDescriptors(artifact,{by:'members'});
const operation=artifact.operations.find(operation=>operation.name==='CreatedInputs.make');
assert.equal(operation.result.type,'CreatedInputs.Record');
assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,operation.result.disclosure);
const model=artifact.models.find(model=>model.name==='CreatedInputs.Record');
assert.equal(model.parent,'CreatedInputs.Parent');
assert.deepEqual(module.appDefinition.models[model.name].uniques,[{fields:['title']}]);
assert.deepEqual(model.fields.map(field=>field.name),['title','account','payload','owner','count']);
assert.equal(model.fields.find(field=>field.name==='title').trim,true);
assert.deepEqual(model.fields.find(field=>field.name==='count').default,{kind:'literal',value:'0'});
assert.equal(loaded.containment.get(model.name).parent,'CreatedInputs.Parent');
assert.equal(loaded.serverInits.get(model.name).get('account'),'actor');
assert.deepEqual(artifact.operations.filter(operation=>operation.kind==='scenario').map(operation=>operation.name),['CreatedInputs.make']);
const callable=artifact.callables.find(callable=>callable.id===operation.name);let handler=factory;
for(const member of callable.member)handler=handler[member];assert.equal(typeof handler,'function');
assert.equal(module[callable.export],operation.name);
console.log('original populated constructor source joins actual CLI/installed schema without public CRUD; genuine execution remains Dev-owned');
"#).unwrap();
    let run = std::process::Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("modules"))
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&run.stdout));
}
