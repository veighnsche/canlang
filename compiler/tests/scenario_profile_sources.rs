//! Original required stored-reference scalar source closure. No native Profile view is fabricated.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::effects::{EffectTables, check_effects};
use canlang_compiler::analysis::resolve::{self, Binding, SymbolKind};
use canlang_compiler::analysis::scenario_disclosure::{
    CheckedScenarioDisclosure, DependencyRole, ScenarioDisclosure, analyze_scenario_disclosure,
};
use canlang_compiler::analysis::{
    CheckedProgram, NodeKey, ResolveTables, ResolvedType, Scalar, SymbolId, TypeTable,
    check_program, types,
};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir, js};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, SourceId, Span, sha256_hex};
use canlang_compiler::syntax::{self, SyntaxKind, SyntaxNode};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

const SOURCE: &str = include_str!("fixtures/source-profile-scalars.can");
const HASH: &str = "06e8633f8d0b8d1b7b57333447a4bda47db36676db8b43bab5259f6064693995";
const OWNER: &str = "SourceProfileScalars.ask";

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
fn checked(source: &str, path: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
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
fn complete<'a>(program: &'a CheckedProgram, name: &str) -> &'a CheckedScenarioDisclosure {
    let proof = &program.scenario_disclosures()[&symbol(program, name)];
    let ScenarioDisclosure::Complete(proof) = proof else {
        panic!("{name}: {proof:?}")
    };
    proof
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
    let file = db.add("profile.can".into(), source.into());
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

#[test]
fn original_profile_schema_and_each_required_reference_scalar_occurrence_survive_ir() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let original = include_str!("fixtures/original-a850/CanChat.can");
    for clause in SOURCE.lines().map(str::trim).filter(|line| {
        line.starts_with("Profile {")
            || line.starts_with("policy Profile")
            || line.starts_with("invariant Profile")
            || line.starts_with("lock Profile")
    }) {
        assert!(
            original.lines().map(str::trim).any(|line| line == clause),
            "unchanged original Profile clause: {clause}"
        );
    }
    let (db, program, ir, _) = checked(SOURCE, "profile.can");
    let profile = symbol(&program, "SourceProfileScalars.Profile");
    let branch = symbol(&program, "SourceProfileScalars.Branch");
    let field = symbol(&program, "SourceProfileScalars.Branch.profile");
    let schema = &program.effects.models[&profile];
    assert_eq!(
        schema
            .fields
            .iter()
            .map(|field| program.symbols[field.field.0 as usize].name.as_str())
            .collect::<Vec<_>>(),
        [
            "name",
            "provider_key",
            "policy_revision",
            "system_prompt",
            "input_tokens",
            "output_tokens",
            "duration",
            "active"
        ]
    );
    for (name, value) in [
        ("input_tokens", "8192"),
        ("output_tokens", "2048"),
        ("duration", "120s"),
        ("active", "true"),
    ] {
        let field = schema
            .fields
            .iter()
            .find(|field| program.symbols[field.field.0 as usize].name == name)
            .unwrap();
        assert_eq!(text(&db, field.default.unwrap()), value);
        assert!(field.server.is_none());
    }
    assert_eq!(schema.invariants.len(), 1);
    assert_eq!(schema.locks.len(), 1);
    assert_eq!(
        program.types.symbol_types[&field],
        ResolvedType::Record {
            symbol: profile,
            stored: true
        }
    );
    let field_schema = program.effects.models[&branch]
        .fields
        .iter()
        .find(|data| data.field == field)
        .unwrap();
    assert!(field_schema.default.is_none() && field_schema.server.is_none());
    let proof = complete(&program, OWNER);
    assert_eq!(proof.source.sha256, HASH);
    assert_eq!(proof.source.path, "profile.can");
    assert_eq!(proof.effects.len(), 1);
    assert_eq!(proof.returns.len(), 1);
    let returned = &proof.returns[0];
    assert_eq!(text(&db, returned.node), "return run");
    assert!(returned.influences.is_empty());
    let mut ids = HashSet::new();
    for read in &returned.dependencies {
        assert!(ids.insert(&read.id));
        assert_eq!(read.source, proof.source);
        assert!(read.calls.is_empty() && read.query_id.is_none());
        if read.model == branch {
            assert_eq!(read.field, field);
            assert_eq!(read.field_name, "profile");
            assert_eq!(read.type_id, "SourceProfileScalars.Profile");
            assert_eq!(text(&db, read.node), "branch.profile");
        } else {
            assert_eq!(read.model, profile);
            assert_eq!(
                read.field,
                symbol(
                    &program,
                    &format!("SourceProfileScalars.Profile.{}", read.field_name)
                )
            );
            assert_eq!(
                read.role,
                if read.field_name == "active" {
                    DependencyRole::Control
                } else {
                    DependencyRole::Data
                }
            );
            assert_eq!(read.ty, program.types.symbol_types[&read.field]);
        }
    }
    let data = returned
        .dependencies
        .iter()
        .filter(|read| read.role == DependencyRole::Data)
        .collect::<Vec<_>>();
    let leaves = data
        .iter()
        .filter(|read| read.model == profile)
        .copied()
        .collect::<Vec<_>>();
    assert_eq!(
        leaves
            .iter()
            .map(|read| read.field_name.as_str())
            .collect::<Vec<_>>(),
        [
            "input_tokens",
            "output_tokens",
            "system_prompt",
            "provider_key",
            "policy_revision",
            "input_tokens",
            "output_tokens",
            "duration"
        ]
    );
    assert_eq!(data.len(), leaves.len() * 2);
    for pair in data.as_chunks::<2>().0 {
        assert_eq!(pair[0].model, branch);
        assert_eq!(pair[1].model, profile);
        assert!(pair[0].node.start >= pair[1].node.start && pair[0].node.end < pair[1].node.end);
    }
    let controls = returned
        .dependencies
        .iter()
        .filter(|read| read.role == DependencyRole::Control)
        .collect::<Vec<_>>();
    assert!(
        controls.is_empty(),
        "shared Require owns the original control reads"
    );
    assert_eq!(
        format!("{:?}", ir.scenario_disclosures[&symbol(&program, OWNER)]),
        format!(
            "{:?}",
            program.scenario_disclosures()[&symbol(&program, OWNER)]
        )
    );
    let ir::IrItemKind::Scenario {
        guards, effects, ..
    } = &ir.items[symbol(&program, OWNER).0 as usize].kind
    else {
        panic!("scenario")
    };
    let [ir::IrStmt::Require { cond, .. }] = guards.as_slice() else {
        panic!("active guard")
    };
    assert_eq!(
        db.get(cond.span.file).unwrap().text[cond.span.start as usize..cond.span.end as usize]
            .trim(),
        "branch.profile.active"
    );
    let [
        ir::IrStmt::Let { name, value, .. },
        ir::IrStmt::Create { input, binding, .. },
        ir::IrStmt::Return {
            value: Some(result),
            ..
        },
    ] = effects.as_slice()
    else {
        panic!("original source order")
    };
    assert_eq!(name, "reserve");
    assert!(matches!(
        value.expr,
        ir::IrExpr::Binary {
            op: ir::IrBinOp::Add,
            ..
        }
    ));
    assert_eq!(binding.as_deref(), Some("run"));
    assert!(matches!(&result.expr,ir::IrExpr::Name(name) if name=="run"));
    assert!(
        matches!(&input.expr,ir::IrExpr::Object(fields) if fields.iter().map(|(name,_)|name.as_str()).collect::<Vec<_>>()==["parent","reserved","system_prompt","provider_key","policy_revision","input_tokens","output_tokens","duration"])
    );
}

#[test]
fn unchanged_original_ask_keeps_profile_guard_payload_and_repeated_token_type_inventory() {
    let source = include_str!("fixtures/original-a850/CanChat.can");
    let mut db = SourceDb::new();
    let file = db.add("CanChat.can".into(), source.into());
    let catalog = catalog(file);
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let ask = program
        .effects
        .scenarios
        .get(&symbol(&program, "chat.ask"))
        .unwrap();
    assert!(source.contains("require can_use(actor,branch.parent) and branch.profile.active and trim(prompt)!=\"\" and count(attachments)<=8"));
    assert!(
        source.contains("let reserve=branch.profile.input_tokens+branch.profile.output_tokens")
    );
    let mut original = program
        .types
        .node_types
        .iter()
        .filter(|(node, _)| {
            node.kind == SyntaxKind::Member as u8
                && node.file == ask.node.file
                && node.start >= ask.node.start
                && node.end <= ask.node.end
                && text(&db, **node).starts_with("branch.profile.")
        })
        .collect::<Vec<_>>();
    original.sort_by_key(|(node, _)| (node.start, node.end));
    assert_eq!(
        original
            .iter()
            .map(|(node, _)| text(&db, **node))
            .collect::<Vec<_>>(),
        [
            "branch.profile.active",
            "branch.profile.input_tokens",
            "branch.profile.output_tokens",
            "branch.profile.system_prompt",
            "branch.profile.provider_key",
            "branch.profile.policy_revision",
            "branch.profile.input_tokens",
            "branch.profile.output_tokens",
            "branch.profile.duration",
            "branch.profile.active",
        ]
    );
    for (node, ty) in original {
        let leaf = text(&db, *node).rsplit('.').next().unwrap();
        assert_eq!(
            ty,
            &program.types.symbol_types[&symbol(&program, &format!("chat.Profile.{leaf}"))]
        );
    }
    assert!(
        program.scenario_disclosures()[&symbol(&program, "chat.ask")]
            .source_facts()
            .is_some(),
        "original owning source retained without full-application/native credit"
    );
}

#[test]
fn original_required_profile_source_binding_types_schema_and_defaults_cannot_be_forged() {
    let (db, trees, resolve, types, effects) = raw(SOURCE);
    let owner = resolve.by_canonical[OWNER];
    let profile = resolve.by_canonical["SourceProfileScalars.Profile"];
    let branch = resolve.by_canonical["SourceProfileScalars.Branch"];
    let field = resolve.by_canonical["SourceProfileScalars.Branch.profile"];
    let inventory = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
    assert!(
        matches!(inventory[&owner], ScenarioDisclosure::Complete(_)),
        "authentic source baseline"
    );
    let ref_node = *types
        .node_types
        .keys()
        .filter(|node| {
            node.kind == SyntaxKind::Member as u8 && text(&db, **node) == "branch.profile"
        })
        .min_by_key(|node| node.start)
        .unwrap();
    let leaf = *types
        .node_types
        .keys()
        .find(|node| {
            node.kind == SyntaxKind::Member as u8
                && text(&db, **node) == "branch.profile.system_prompt"
        })
        .unwrap();
    let root_node = *types
        .node_types
        .keys()
        .filter(|node| node.kind == SyntaxKind::NameRef as u8 && text(&db, **node) == "branch")
        .min_by_key(|node| node.start)
        .unwrap();
    let parameter = effects.scenarios[&owner].params[0].param;
    let default = effects.models[&profile]
        .fields
        .iter()
        .find_map(|field| field.default)
        .unwrap();
    for mode in [
        "root",
        "formal",
        "parameter-default",
        "reference-type",
        "nullable",
        "leaf-type",
        "field-owner",
        "target-owner",
        "field-default",
        "field-server",
    ] {
        let mut changed_resolve = resolve.clone();
        let mut changed_types = types.clone();
        let mut changed_effects = effects.clone();
        match mode {
            "root" => {
                changed_resolve
                    .node_binding
                    .insert(root_node, Binding::Symbol(profile));
            }
            "formal" => {
                changed_types.symbol_types.insert(
                    parameter,
                    ResolvedType::Nullable(Box::new(ResolvedType::Record {
                        symbol: branch,
                        stored: true,
                    })),
                );
            }
            "parameter-default" => {
                changed_effects.scenarios.get_mut(&owner).unwrap().params[0].default = Some(default)
            }
            "reference-type" => {
                changed_types.node_types.insert(
                    ref_node,
                    ResolvedType::Record {
                        symbol: branch,
                        stored: true,
                    },
                );
            }
            "nullable" => {
                changed_types.symbol_types.insert(
                    field,
                    ResolvedType::Nullable(Box::new(ResolvedType::Record {
                        symbol: profile,
                        stored: true,
                    })),
                );
            }
            "leaf-type" => {
                changed_types
                    .node_types
                    .insert(leaf, ResolvedType::Scalar(Scalar::Int));
            }
            "field-owner" => {
                let SymbolKind::Field { owner, .. } =
                    &mut changed_resolve.symbols[field.0 as usize].kind
                else {
                    panic!("field")
                };
                *owner = profile;
            }
            "target-owner" => {
                changed_resolve.symbols[profile.0 as usize].canonical = "Foreign.Profile".into()
            }
            "field-default" | "field-server" => {
                let field = changed_effects
                    .models
                    .get_mut(&branch)
                    .unwrap()
                    .fields
                    .iter_mut()
                    .find(|data| data.field == field)
                    .unwrap();
                if mode == "field-default" {
                    field.default = Some(default)
                } else {
                    field.server = Some(default)
                }
            }
            _ => unreachable!(),
        }
        let proof = analyze_scenario_disclosure(
            &db,
            &trees,
            &changed_resolve,
            &changed_types,
            &changed_effects,
        );
        assert!(
            matches!(proof[&owner], ScenarioDisclosure::Declined(_)),
            "{mode}: edited source facts cannot admit Profile scalar receiver"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "profile.can".into(),
        SOURCE.replace("provider_key:text", "provider_key:int "),
    );
    assert!(
        matches!(
            analyze_scenario_disclosure(&stale, &trees, &resolve, &types, &effects)[&owner],
            ScenarioDisclosure::Declined(_)
        ),
        "stale original field schema"
    );
    for (case, changed) in [
        SOURCE
            .replace("  do\n", "  do\n   let copied=branch.profile\n")
            .replace(
                "system_prompt=branch.profile.system_prompt",
                "system_prompt=copied.system_prompt",
            ),
        SOURCE
            .replace(
                " policy Profile",
                " derive provider(branch:Branch):text=branch.profile.provider_key\n policy Profile",
            )
            .replace(
                "provider_key=branch.profile.provider_key",
                "provider_key=provider(branch)",
            ),
        SOURCE
            .replace(" profile:Profile }", " profile:Wrapper }")
            .replace(
                " Run in Branch",
                " Wrapper {profile:Profile}\n policy Wrapper read=members\n Run in Branch",
            )
            .replace("branch.profile.", "branch.profile.profile."),
    ]
    .into_iter()
    .enumerate()
    {
        let (db, trees, resolve, types, effects) = raw(&changed);
        let owner = resolve.by_canonical[OWNER];
        let disclosure = analyze_scenario_disclosure(&db, &trees, &resolve, &types, &effects);
        if case == 2 {
            assert!(
                matches!(disclosure[&owner], ScenarioDisclosure::Declined(_)),
                "multiple-hop source receiver case {case}"
            );
        } else {
            assert!(
                matches!(disclosure[&owner], ScenarioDisclosure::Complete(_)),
                "{}",
                if case == 1 {
                    "source-owned helper now carries its checked formal and original field dependency"
                } else {
                    "copied alias keeps its original required reference and field dependency"
                }
            );
        }
    }
}

#[test]
fn source_complete_profile_emits_with_original_source_and_keeps_no_source_refusal() {
    let (db, program, ir, catalog) = checked(SOURCE, "profile.can");
    complete(&program, OWNER);
    let mut result = DiagnosticResult::new("profile-source", "1.0", 1);
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
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "bare IR lacks the fresh shared Require source context: {:?}",
        raw.diagnostics
    );
    // The installed CLI/descriptor/facade join is exercised by the owning
    // native_profile_scalars target; raw emission still needs original source.
    let unprepared = js::emit_program_with_native_receipts(&ir, true);
    assert!(
        unprepared
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        unprepared.diagnostics
    );
    assert!(
        unprepared
            .operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .unwrap()
            .disclosure
            .is_none()
    );
}
