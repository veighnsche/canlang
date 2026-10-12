//! Original transcript source/IR consumer only; no stored messages, Files or native query authority is issued.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::effects::{EffectTables, check_effects};
use canlang_compiler::analysis::resolve::{self, Binding, SymbolKind};
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, InfluenceKind, ScenarioDisclosure, analyze_scenario_disclosure,
};
use canlang_compiler::analysis::types::SelectedCallTarget;
use canlang_compiler::analysis::{
    CheckedProgram, NodeKey, ResolveTables, ResolvedType, Scalar, SymbolId, TypeTable,
    check_program, types,
};
use canlang_compiler::codegen::scenario_decisions::collect_decision_sources;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir, js};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, SourceId, Span, sha256_hex};
use canlang_compiler::syntax::{self, SyntaxNode};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const SOURCE: &str = include_str!("fixtures/source-transcript.can");
const HASH: &str = "c198c3b891cc577b2b928039abd695da227a8ee21da49258c802dc61d216511c";
const OWNER: &str = "SourceTranscript.compose";
const HELPER: &str = "SourceTranscript.transcript";
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn native_owner() -> PathBuf {
    let primary = Path::new("/Users/vince/Projects/canlang");
    if primary
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        primary.into()
    } else {
        root()
    }
}
fn catalog(file: SourceId) -> Catalog {
    let path = native_owner().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}
fn checked(source: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("transcript.can".into(), source.into());
    let catalog = catalog(file);
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}
fn text(db: &SourceDb, node: NodeKey) -> &str {
    db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
}
fn symbol(program: &CheckedProgram, name: &str) -> SymbolId {
    program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == name)
        .unwrap()
        .id
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
    let file = db.add("transcript.can".into(), source.into());
    let catalog = catalog(file);
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
fn message_array(ty: &ResolvedType) {
    let ResolvedType::Array {
        element,
        ordered: true,
        ..
    } = ty
    else {
        panic!("original ordered TextMessage[]")
    };
    let ResolvedType::StdNominal { name, fields } = element.as_ref() else {
        panic!("sealed std identity")
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
            cases: vec!["system".into(), "user".into(), "assistant".into()],
            owner: None,
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
fn original_transcript_prefix_projection_and_each_caller_are_consumed_by_real_count_concat_ir() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let original = include_str!("fixtures/original-a850/CanChat.can");
    for clause in SOURCE.lines().map(str::trim).filter(|line| {
        line.starts_with("export Branch ")
            || line.starts_with("export Turn ")
            || line.starts_with("export derive transcript")
            || line.starts_with("policy Branch")
            || line.starts_with("policy Turn")
            || line.starts_with("lock Branch")
            || line.starts_with("lock Turn")
            || line.starts_with("unique Turn")
            || line.starts_with("invariant Turn")
    }) {
        assert!(
            original.lines().map(str::trim).any(|line| line == clause),
            "unchanged original relevant declaration: {clause}"
        );
    }
    assert!(original.contains("require count(transcript(branch))<120"));
    assert!(original.contains("let messages=[TextMessage {role=system,content=branch.profile.system_prompt,attachments=[]}]+transcript(branch)+[TextMessage {role=user,content=prompt,attachments}]"));
    let (db, program, ir, catalog) = checked(SOURCE);
    let owner = symbol(&program, OWNER);
    let helper = symbol(&program, HELPER);
    let branch = symbol(&program, "SourceTranscript.Branch");
    let turn = symbol(&program, "SourceTranscript.Turn");
    let ScenarioDisclosure::Complete(proof) = &program.scenario_disclosures()[&owner] else {
        panic!(
            "actual bounded transcript consumer: {:?}",
            program.scenario_disclosures()[&owner]
        )
    };
    assert!(proof.effects.is_empty());
    assert_eq!(proof.returns.len(), 1);
    let returned = &proof.returns[0];
    assert_eq!(text(&db, returned.node), "return count(messages)");
    assert_eq!(returned.influences.len(), 8);
    let mut callers = program
        .types
        .selected_calls
        .iter()
        .filter(|(node, call)| {
            matches!(&call.target,SelectedCallTarget::DeriveFn(id) if *id==helper)
                && node.start >= proof.node.start
                && node.end <= proof.node.end
        })
        .collect::<Vec<_>>();
    callers.sort_by_key(|(node, _)| node.start);
    assert_eq!(callers.len(), 2);
    assert_ne!(callers[0].0, callers[1].0);
    for (node, call) in &callers {
        assert_eq!(text(&db, **node), "transcript(branch)");
        assert_eq!(call.slots, [Some(0)]);
        assert_eq!(text(&db, call.arguments[0]), "branch");
        message_array(&program.types.node_types[*node]);
        assert!(matches!(
            program.types.node_types[*node],
            ResolvedType::Array {
                nonempty: false,
                ..
            }
        ));
    }
    let groups = returned.influences.as_chunks::<4>().0;
    assert_eq!(groups.len(), 2);
    let first_id = groups[0][0].query_id.as_ref().unwrap();
    let later_id = groups[1][0].query_id.as_ref().unwrap();
    assert_ne!(first_id, later_id);
    for group in groups {
        assert_eq!(
            group
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
            group
                .iter()
                .all(|influence| influence.query_id == group[0].query_id
                    && influence.source == proof.source)
        );
    }
    let prefix = symbol(&program, "SourceTranscript.Branch.prefix");
    message_array(&program.types.symbol_types[&prefix]);
    let prefixes = returned
        .dependencies
        .iter()
        .filter(|read| read.field == prefix)
        .collect::<Vec<_>>();
    assert_eq!(prefixes.len(), 2);
    assert_ne!(prefixes[0].id, prefixes[1].id);
    for (read, (caller, _)) in prefixes.iter().zip(&callers) {
        assert_eq!(read.model, branch);
        assert_eq!(text(&db, read.node), "branch.prefix");
        assert_eq!(read.type_id, "TextMessage[]");
        assert_eq!(read.calls, [**caller]);
        assert_eq!(read.source, proof.source);
    }
    assert_eq!(prefixes[0].role, DependencyRole::Control);
    assert_eq!(prefixes[1].role, DependencyRole::Data);
    assert_eq!(
        format!("{:?}", ir.scenario_disclosures[&owner]),
        format!("{:?}", program.scenario_disclosures()[&owner])
    );
    let ir::IrItemKind::DeriveFn {
        params,
        expr: Some(body),
        ..
    } = &ir.items[helper.0 as usize].kind
    else {
        panic!("exact original helper")
    };
    assert_eq!(params.len(), 1);
    let ir::IrExpr::Binary {
        op: ir::IrBinOp::Add,
        left: prefix,
        right: query,
    } = &body.expr
    else {
        panic!("original eager prefix + ordered query")
    };
    message_array(&body.ty);
    message_array(&prefix.ty);
    message_array(&query.ty);
    assert!(matches!(&prefix.expr,ir::IrExpr::Member{field,..} if field=="prefix"));
    let ir::IrExpr::Query(query) = &query.expr else {
        panic!("real owning query")
    };
    assert!(
        matches!(&query.domain,ir::IrQueryDomain::Model(model) if model=="SourceTranscript.Turn")
    );
    assert!(
        matches!(&query.parent.as_ref().unwrap().expr,ir::IrExpr::Name(name) if name=="branch")
    );
    assert!(query.where_pred.is_none() && query.limit.is_none() && query.archived.is_none());
    assert_eq!(query.order.len(), 1);
    assert_eq!(query.order[0].field, "position");
    assert!(!query.order[0].descending);
    let selected = query.select.as_ref().unwrap();
    let ResolvedType::Array {
        element: catalog_message,
        ..
    } = &program.types.symbol_types[&symbol(&program, "SourceTranscript.Branch.prefix")]
    else {
        panic!("actual catalog-produced stored prefix")
    };
    assert_eq!(&selected.ty, catalog_message.as_ref());
    let ir::IrExpr::Object(fields) = &selected.expr else {
        panic!("actual TextMessage construction")
    };
    assert_eq!(
        fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["role", "content", "attachments"]
    );
    for (name, value) in fields {
        assert_eq!(
            value.ty,
            program.types.symbol_types[&symbol(&program, &format!("SourceTranscript.Turn.{name}"))]
        );
        assert!(matches!(&value.expr,ir::IrExpr::Member{field,..} if field==name));
    }
    assert_eq!(program.effects.models[&turn].locks.len(), 1);
    let ir::IrItemKind::Scenario {
        guards, effects, ..
    } = &ir.items[owner.0 as usize].kind
    else {
        panic!("scenario")
    };
    assert_eq!(guards.len(), 1);
    let [
        ir::IrStmt::Let { name, value, .. },
        ir::IrStmt::Return {
            value: Some(count), ..
        },
    ] = effects.as_slice()
    else {
        panic!("source order")
    };
    assert_eq!(name, "messages");
    message_array(&value.ty);
    let ir::IrExpr::Binary {
        op: ir::IrBinOp::Add,
        left,
        right,
    } = &value.expr
    else {
        panic!("later user concat")
    };
    assert!(matches!(
        &left.expr,
        ir::IrExpr::Binary {
            op: ir::IrBinOp::Add,
            ..
        }
    ));
    let ir::IrExpr::Array(elements) = &right.expr else {
        panic!("original user messages")
    };
    assert_eq!(elements.len(), 1);
    assert_eq!(&elements[0].ty, catalog_message.as_ref());
    let (ir::IrExpr::Call {
        target: ir::IrCallTarget::Builtin { id, .. },
        args,
    }
    | ir::IrExpr::BoundCall {
        target: ir::IrCallTarget::Builtin { id, .. },
        args,
        ..
    }) = &count.expr
    else {
        panic!("real count consumer")
    };
    assert_eq!(id, "count");
    assert!(matches!(&args[0].expr,ir::IrExpr::Name(name) if name=="messages"));
    assert!(
        collect_decision_sources(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog)
        )
        .is_some(),
        "actual leading count/helper source correspondence"
    );
}

#[test]
fn same_span_ir_helper_count_concat_slots_order_and_nominal_mutants_lose_original_correspondence() {
    let (db, program, ir, catalog) = checked(SOURCE);
    let owner = symbol(&program, OWNER);
    let helper = symbol(&program, HELPER);
    assert!(
        collect_decision_sources(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog)
        )
        .is_some()
    );
    for mode in [
        "order",
        "projection",
        "prefix",
        "formal",
        "formal-name",
        "count",
        "slots",
        "bound",
        "concat",
        "nominal",
        "return-alias",
    ] {
        let mut changed = ir.clone();
        if mode == "formal-name" {
            let ir::IrItemKind::DeriveFn { params, .. } = &changed.items[helper.0 as usize].kind
            else {
                panic!("helper")
            };
            let formal = params[0];
            // The signature consumes this name while the checked body still
            // reads branch. Keeping type/span/canonical is insufficient.
            changed.items[formal.0 as usize].name = "copied".into();
        } else if mode == "formal" {
            let ir::IrItemKind::DeriveFn { params, .. } = &changed.items[helper.0 as usize].kind
            else {
                panic!("helper")
            };
            let formal = params[0];
            let ir::IrItemKind::Param { ty, .. } = &mut changed.items[formal.0 as usize].kind
            else {
                panic!("formal")
            };
            *ty = ir::IrType::Known(ResolvedType::Record {
                symbol: symbol(&program, "SourceTranscript.Turn"),
                stored: true,
            });
        } else if matches!(mode, "order" | "projection" | "prefix") {
            let ir::IrItemKind::DeriveFn {
                expr: Some(body), ..
            } = &mut changed.items[helper.0 as usize].kind
            else {
                panic!("helper")
            };
            let ir::IrExpr::Binary { left, right, .. } = &mut body.expr else {
                panic!("concat")
            };
            if mode == "prefix" {
                let ir::IrExpr::Member { field, .. } = &mut left.expr else {
                    panic!("prefix")
                };
                *field = "origin".into();
            } else {
                let ir::IrExpr::Query(query) = &mut right.expr else {
                    panic!("query")
                };
                if mode == "order" {
                    query.order[0].descending = true;
                } else {
                    let ir::IrExpr::Object(fields) = &mut query.select.as_mut().unwrap().expr
                    else {
                        panic!("selected")
                    };
                    fields.swap(0, 1);
                }
            }
        } else {
            let ir::IrItemKind::Scenario {
                guards, effects, ..
            } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if matches!(mode, "count" | "slots" | "bound" | "nominal") {
                let ir::IrStmt::Require { cond, .. } = &mut guards[0] else {
                    panic!("require")
                };
                let ir::IrExpr::Binary { left, right, .. } = &mut cond.expr else {
                    panic!("bound")
                };
                if mode == "bound" {
                    right.expr = ir::IrExpr::Int(121);
                } else {
                    let (ir::IrExpr::Call { target, args }
                    | ir::IrExpr::BoundCall { target, args, .. }) = &mut left.expr
                    else {
                        panic!("count")
                    };
                    if mode == "count" {
                        let ir::IrCallTarget::Builtin { id, .. } = target else {
                            panic!("builtin")
                        };
                        *id = "first".into();
                    } else if mode == "slots" {
                        let (ir::IrExpr::Call { target, args }
                        | ir::IrExpr::BoundCall { target, args, .. }) = &args[0].expr
                        else {
                            panic!("transcript")
                        };
                        let replacement = ir::IrExpr::BoundCall {
                            target: target.clone(),
                            args: args.clone(),
                            slots: vec![None],
                        };
                        let (ir::IrExpr::Call { args, .. } | ir::IrExpr::BoundCall { args, .. }) =
                            &mut left.expr
                        else {
                            panic!("count")
                        };
                        args[0].expr = replacement;
                    } else {
                        let ResolvedType::Array { element, .. } = &mut args[0].ty else {
                            panic!("TextMessage[]")
                        };
                        let ResolvedType::StdNominal { name, .. } = element.as_mut() else {
                            panic!("std")
                        };
                        *name = "ForeignTextMessage";
                    }
                }
            } else if mode == "concat" {
                let ir::IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!("messages")
                };
                let ir::IrExpr::Binary { op, .. } = &mut value.expr else {
                    panic!("concat")
                };
                *op = ir::IrBinOp::Sub;
            } else {
                let ir::IrStmt::Return {
                    value: Some(value), ..
                } = &mut effects[1]
                else {
                    panic!("return")
                };
                let (ir::IrExpr::Call { args, .. } | ir::IrExpr::BoundCall { args, .. }) =
                    &mut value.expr
                else {
                    panic!("count")
                };
                args[0].expr = ir::IrExpr::Name("copied".into());
            }
        }
        assert!(
            collect_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog)
            )
            .is_none(),
            "{mode}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "transcript.can".into(),
        SOURCE.replace("transcript(branch)", "transcript(copied)"),
    );
    assert!(
        collect_decision_sources(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &stale,
            Some(&catalog)
        )
        .is_none()
    );
}

#[test]
fn source_helper_root_schema_alias_default_and_unmarked_count_profiles_refuse() {
    let scalar = "app TranscriptName\nGiven\n derive transcript(value:int):int = value+1\nWhen\n scenario run(value:int) by=members -> int\n  do return transcript(value)\nThen\n";
    let (db, trees, resolve, types, effects) = raw(scalar);
    assert!(
        matches!(
            analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects)
                [&resolve.by_canonical["TranscriptName.run"]],
            ScenarioDisclosure::Complete(_)
        ),
        "an unrelated scalar derive keeps its existing behavior"
    );
    let (db, trees, resolve, types, effects) = raw(SOURCE);
    let owner = resolve.by_canonical[OWNER];
    let helper = resolve.by_canonical[HELPER];
    let prefix = resolve.by_canonical["SourceTranscript.Branch.prefix"];
    let turn = resolve.by_canonical["SourceTranscript.Turn"];
    let attachments = resolve.by_canonical["SourceTranscript.Turn.attachments"];
    assert!(
        matches!(
            analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects)[&owner],
            ScenarioDisclosure::Complete(_)
        ),
        "genuine source baseline"
    );
    let caller = *types
        .selected_calls
        .iter()
        .filter(|(node, call)| {
            node.start >= effects.scenarios[&owner].node.start
                && matches!(&call.target,SelectedCallTarget::DeriveFn(id) if *id==helper)
        })
        .min_by_key(|(node, _)| node.start)
        .unwrap()
        .0;
    let source_parameter = effects.scenarios[&owner].params[0].param;
    let helper_parameter = effects.derives[&helper].params[0].param;
    for mode in [
        "root",
        "slots",
        "formal",
        "default",
        "prefix-nominal",
        "file-type",
        "field-owner",
        "foreign-model",
        "array-order",
    ] {
        let mut resolve = resolve.clone();
        let mut types = types.clone();
        let mut effects = effects.clone();
        match mode {
            "root" => {
                let argument = types.selected_calls[&caller].arguments[0];
                resolve
                    .node_binding
                    .insert(argument, Binding::Symbol(helper_parameter));
            }
            "slots" => types.selected_calls.get_mut(&caller).unwrap().slots = vec![None],
            "formal" => {
                types.symbol_types.insert(
                    helper_parameter,
                    ResolvedType::Record {
                        symbol: turn,
                        stored: true,
                    },
                );
            }
            "default" => {
                effects.derives.get_mut(&helper).unwrap().params[0].default =
                    Some(types.selected_calls[&caller].arguments[0])
            }
            "prefix-nominal" => {
                let ResolvedType::Array { element, .. } =
                    types.symbol_types.get_mut(&prefix).unwrap()
                else {
                    panic!("prefix")
                };
                let ResolvedType::StdNominal { name, .. } = element.as_mut() else {
                    panic!("std")
                };
                *name = "ForeignTextMessage";
            }
            "file-type" => {
                types.symbol_types.insert(
                    attachments,
                    ResolvedType::Array {
                        element: Box::new(ResolvedType::Scalar(Scalar::Text)),
                        ordered: true,
                        nonempty: false,
                    },
                );
            }
            "field-owner" => {
                let SymbolKind::Field { owner, .. } =
                    &mut resolve.symbols[attachments.0 as usize].kind
                else {
                    panic!("field")
                };
                *owner = resolve.by_canonical["SourceTranscript.Branch"];
            }
            "foreign-model" => resolve.symbols[turn.0 as usize].canonical = "Foreign.Turn".into(),
            "array-order" => {
                let ResolvedType::Array { ordered, .. } =
                    types.symbol_types.get_mut(&prefix).unwrap()
                else {
                    panic!("prefix")
                };
                *ordered = false;
            }
            _ => unreachable!(),
        }
        let proof = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
        assert!(
            matches!(proof[&owner], ScenarioDisclosure::Declined(_)),
            "{mode}"
        );
    }
    assert_ne!(source_parameter, helper_parameter);
    for source in [
        SOURCE
            .replace("  do\n", "  do\n   let copied=branch\n")
            .replace("+transcript(branch)+", "+transcript(copied)+"),
        SOURCE
            .replace(
                "compose(branch:Branch,",
                "compose(branch:Branch,holder:Holder,",
            )
            .replace(
                " Run in Branch",
                " Holder {branch:Branch}\n policy Holder read=members\n Run in Branch",
            )
            .replace("transcript(branch))<120", "transcript(holder.branch))<120"),
        SOURCE.replace(
            "count(transcript(branch))<120",
            "count([TextMessage {role=user,content=\"Unmarked\",attachments=[]}])<120",
        ),
    ] {
        let (db, trees, resolve, types, effects) = raw(&source);
        assert!(
            matches!(
                analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects)
                    [&resolve.by_canonical[OWNER]],
                ScenarioDisclosure::Declined(_)
            ),
            "copied/multiple-hop/unmarked source must not borrow transcript proof"
        );
    }
}

#[test]
fn genuine_transcript_scalar_source_still_requires_released_native_receiving_correspondence() {
    let (db, program, ir, catalog) = checked(SOURCE);
    assert!(matches!(
        program.scenario_disclosures()[&symbol(&program, OWNER)],
        ScenarioDisclosure::Complete(_)
    ));
    let mut result = DiagnosticResult::new("transcript-source", "1.0", 1);
    result.add_sources(&db);
    let (_, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("transcript")),
        "{diagnostics:?}"
    );
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("transcript")),
        "{:?}",
        raw.diagnostics
    );
    assert!(
        raw.operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .unwrap()
            .disclosure
            .is_none()
    );
    // Only real existing declaration identities are substituted; original
    // source item position must still trigger the source-only native gate.
    let owner = symbol(&program, OWNER);
    let helper = symbol(&program, HELPER);
    for mode in ["id", "canonical"] {
        let mut changed = ir.clone();
        if mode == "id" {
            changed.items[owner.0 as usize].id = helper;
        } else {
            changed.items[owner.0 as usize].canonical = HELPER.into();
        }
        let output = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("transcript")),
            "{mode}: {:?}",
            output.diagnostics
        );
        assert!(
            output
                .operations
                .iter()
                .all(|operation| operation.disclosure.is_none()),
            "{mode}: no substituted native recipe"
        );
    }
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("transcript.can");
    std::fs::write(&path, SOURCE).unwrap();
    let native_catalog = scratch.path().join("native-catalog.json");
    std::fs::copy(
        native_owner().join("packages/cloudflare/dist/native-catalog.json"),
        &native_catalog,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_catalog)
        .arg(&path)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "missing native receiver cannot publish scalar artifact"
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report.get("modules").is_none());
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"
                && diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("transcript")),
        "{report}"
    );
}
