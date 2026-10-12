//! Original current Revision presence/narrowing source lineage; no native current row is reconstructed.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    DependencyRole, DisclosureChoice, ScenarioDisclosure,
};
use canlang_compiler::analysis::{
    CheckedProgram, NodeKey, ResolvedType, Scalar, SymbolId, check_program,
};
use canlang_compiler::codegen::scenario_decisions::collect_decision_sources;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir, js};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use canlang_compiler::syntax::SyntaxKind;
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Command,
};

const SOURCE: &str = include_str!("fixtures/source-current-revision.can");
const HASH: &str = "4da5ddcc956e72ee6f8e0d5942467692c549d925dee2a01a4e01192f93e31bbf";
const OWNER: &str = "SourceCurrentRevision.generate";
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
fn catalog(file: canlang_compiler::source::SourceId) -> Catalog {
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
    let file = db.add("current-revision.can".into(), source.into());
    let catalog = catalog(file);
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}
fn symbol(program: &CheckedProgram, name: &str) -> SymbolId {
    program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == name)
        .unwrap()
        .id
}
fn text(db: &SourceDb, node: NodeKey) -> &str {
    db.get(node.file).unwrap().text[node.start as usize..node.end as usize].trim()
}

#[test]
fn original_current_presence_published_digest_and_same_run_reference_have_real_typed_lineage() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let original = include_str!("fixtures/original-a850/CanCreative.can");
    for clause in SOURCE.lines().map(str::trim).filter(|line| {
        line.starts_with("Template {")
            || line.starts_with("Revision in")
            || line.starts_with("policy Template")
            || line.starts_with("policy Revision")
            || line.starts_with("invariant Template")
            || line.starts_with("invariant Revision")
            || line.starts_with("unique Revision")
            || line.starts_with("lock Template")
            || line.starts_with("lock Revision")
    }) {
        assert!(
            original.lines().map(str::trim).any(|line| line == clause),
            "unchanged original owning clause {clause}"
        );
    }
    let (db, program, ir, catalog) = checked(SOURCE);
    let owner = symbol(&program, OWNER);
    let template = symbol(&program, "SourceCurrentRevision.Template");
    let revision = symbol(&program, "SourceCurrentRevision.Revision");
    let current = symbol(&program, "SourceCurrentRevision.Template.current");
    let revision_ty = ResolvedType::Record {
        symbol: revision,
        stored: true,
    };
    let nullable = ResolvedType::Nullable(Box::new(revision_ty.clone()));
    assert_eq!(program.types.symbol_types[&current], nullable);
    let ScenarioDisclosure::Complete(proof) = &program.scenario_disclosures()[&owner] else {
        panic!(
            "actual source consumer: {:?}",
            program.scenario_disclosures()[&owner]
        )
    };
    assert_eq!(proof.returns.len(), 4);
    assert_eq!(
        proof
            .returns
            .iter()
            .map(|path| &path.id)
            .collect::<HashSet<_>>()
            .len(),
        4
    );
    // Equal source Create proofs are deduplicated across the lazy paths.
    assert_eq!(proof.effects.len(), 1);
    assert_eq!(proof.source.sha256, HASH);
    let ir::IrItemKind::Scenario {
        guards, effects, ..
    } = &ir.items[owner.0 as usize].kind
    else {
        panic!("scenario")
    };
    assert_eq!(guards.len(), 1);
    let ir::IrStmt::Require {
        cond: outer_gate, ..
    } = &guards[0]
    else {
        panic!("leading guard")
    };
    let ir::IrExpr::Binary {
        op: ir::IrBinOp::And,
        left: inner_gate,
        ..
    } = &outer_gate.expr
    else {
        panic!("published gate")
    };
    assert!(matches!(
        inner_gate.expr,
        ir::IrExpr::Binary {
            op: ir::IrBinOp::And,
            ..
        }
    ));
    let [
        ir::IrStmt::Let {
            name,
            value: current_value,
            ..
        },
        ir::IrStmt::Require {
            cond: digest_guard, ..
        },
        ir::IrStmt::Let {
            name: validation,
            value: digest,
            ..
        },
        ir::IrStmt::Create { input, binding, .. },
        ir::IrStmt::Return {
            value: Some(result),
            ..
        },
    ] = effects.as_slice()
    else {
        panic!("original current→digest→capture→Create→Return order")
    };
    assert_eq!(name, "revision");
    assert_eq!(validation, "validation");
    assert_eq!(current_value.ty, revision_ty);
    assert_eq!(digest.ty, ResolvedType::Scalar(Scalar::Text));
    assert_eq!(binding.as_deref(), Some("run"));
    assert!(matches!(&result.expr,ir::IrExpr::Name(name)if name=="run"));
    assert!(matches!(
        &digest_guard.expr,
        ir::IrExpr::Binary {
            op: ir::IrBinOp::Ne,
            ..
        }
    ));
    let ir::IrExpr::Object(fields) = &input.expr else {
        panic!("Run inputs")
    };
    assert_eq!(
        fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["revision", "digest", "outputs", "duration"]
    );
    assert!(matches!(&fields[0].1.expr,ir::IrExpr::Name(name)if name=="revision"));
    assert_eq!(fields[0].1.ty, revision_ty);
    assert_eq!(fields[2].1.ty, ResolvedType::Scalar(Scalar::Int));
    assert_eq!(fields[3].1.ty, ResolvedType::Scalar(Scalar::Duration));
    let published = symbol(&program, "SourceCurrentRevision.Revision.published");
    let mut paths = HashSet::new();
    let mut evaluated = 0;
    for returned in &proof.returns {
        assert!(returned.influences.is_empty());
        assert_eq!(text(&db, returned.node), "return run");
        let choice = |at: Span| {
            let decision = returned
                .decisions
                .iter()
                .find(|decision| {
                    decision.node.file == at.file
                        && decision.node.start == at.start
                        && decision.node.end == at.end
                })
                .unwrap();
            assert!(decision.calls.is_empty());
            match &decision.choice {
                DisclosureChoice::RhsEvaluated => true,
                DisclosureChoice::RhsSkipped => false,
                _ => panic!("actual lazy AND choice"),
            }
        };
        let inner = choice(inner_gate.span);
        let outer = choice(outer_gate.span);
        assert!(paths.insert((inner, outer)));
        let reads = &returned.dependencies;
        assert_eq!(
            reads.iter().any(|read| read.field == current
                && read.role == DependencyRole::Control
                && read.ty == nullable),
            inner,
            "presence read belongs to the actual inner RHS evaluation"
        );
        let published_read = reads.iter().any(|read| {
            read.field == published
                && read.role == DependencyRole::Control
                && text(&db, read.node) == "template.current.published"
        });
        if !outer {
            assert!(!published_read, "skipped published RHS has no read");
        }
        if inner && outer {
            assert!(published_read);
            evaluated += 1;
        }
        assert!(reads.iter().any(|read| read.field == current
            && read.role == DependencyRole::Data
            && read.node.start == current_value.span.start
            && read.node.end == current_value.span.end
            && read.ty == revision_ty));
        for (field, role, occurrence) in [
            ("digest", DependencyRole::Control, "revision.digest"),
            ("digest", DependencyRole::Data, "revision.digest"),
            ("outputs", DependencyRole::Data, "revision.outputs"),
            ("duration", DependencyRole::Data, "revision.duration"),
        ] {
            let field = symbol(&program, &format!("SourceCurrentRevision.Revision.{field}"));
            assert!(
                reads.iter().any(|read| read.field == field
                    && read.role == role
                    && text(&db, read.node) == occurrence),
                "{role:?} {occurrence}"
            );
        }
        for read in reads {
            assert_eq!(read.source, proof.source);
            assert!(read.calls.is_empty() && read.query_id.is_none());
            assert!(read.model == template || read.model == revision);
        }
    }
    assert_eq!(paths.len(), 4);
    assert_eq!(evaluated, 1, "one fully RHS-evaluated original guard path");
    assert_eq!(
        format!("{:?}", ir.scenario_disclosures[&owner]),
        format!("{:?}", program.scenario_disclosures()[&owner])
    );
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
}

#[test]
fn unchanged_original_generate_retains_actual_current_and_digest_narrowing_inventory() {
    let chat = include_str!("fixtures/original-a850/CanChat.can");
    let creative = include_str!("fixtures/original-a850/CanCreative.can");
    let mut db = SourceDb::new();
    let chat_file = db.add("CanChat.can".into(), chat.into());
    let creative_file = db.add("CanCreative.can".into(), creative.into());
    let catalog = catalog(chat_file);
    let (program, diagnostics) = check_program(&db, &[chat_file, creative_file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let scenario = &program.effects.scenarios[&symbol(&program, "creative.generate")];
    let revision = symbol(&program, "creative.Revision");
    assert!(creative.contains("require template.active and template.current!=null and template.current.published and trim(prompt)!=\"\""));
    assert!(creative.contains("let revision=template.current\n    require revision.digest!=null\n    let validation=revision.digest"));
    let mut current = program
        .types
        .node_types
        .iter()
        .filter(|(node, _)| {
            node.kind == SyntaxKind::Member as u8
                && node.file == scenario.node.file
                && node.start >= scenario.node.start
                && node.end <= scenario.node.end
                && text(&db, **node) == "template.current"
        })
        .collect::<Vec<_>>();
    current.sort_by_key(|(node, _)| node.start);
    assert_eq!(current.len(), 3);
    assert_eq!(
        current[0].1,
        &ResolvedType::Nullable(Box::new(ResolvedType::Record {
            symbol: revision,
            stored: true
        }))
    );
    assert!(current[1..].iter().all(|(_, ty)| **ty
        == ResolvedType::Record {
            symbol: revision,
            stored: true
        }));
    for (field, scalar) in [("outputs", Scalar::Int), ("duration", Scalar::Duration)] {
        assert!(
            program
                .types
                .node_types
                .iter()
                .any(|(node, ty)| node.file == scenario.node.file
                    && node.start >= scenario.node.start
                    && node.end <= scenario.node.end
                    && text(&db, *node) == format!("revision.{field}")
                    && *ty == ResolvedType::Scalar(scalar))
        );
    }
    assert!(
        program.scenario_disclosures()[&symbol(&program, "creative.generate")]
            .source_facts()
            .is_some(),
        "original inventory is retained without whole-application credit"
    );
}

#[test]
fn missing_late_copied_current_and_same_span_guard_binding_type_edits_refuse() {
    let (db, program, ir, catalog) = checked(SOURCE);
    let owner = symbol(&program, OWNER);
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
        "guard-stage",
        "null-guard",
        "current-field",
        "current-type",
        "digest-guard",
        "digest-binding",
        "reference-input",
        "published",
    ] {
        let mut changed = ir.clone();
        let ir::IrItemKind::Scenario {
            guards, effects, ..
        } = &mut changed.items[owner.0 as usize].kind
        else {
            panic!("scenario")
        };
        match mode {
            "guard-stage" => effects.insert(0, guards.remove(0)),
            "null-guard" | "published" => {
                let ir::IrStmt::Require { cond, .. } = &mut guards[0] else {
                    panic!("require")
                };
                let ir::IrExpr::Binary { left, right, .. } = &mut cond.expr else {
                    panic!("and")
                };
                if mode == "published" {
                    right.expr = ir::IrExpr::Bool(true);
                } else {
                    let ir::IrExpr::Binary { right, .. } = &mut left.expr else {
                        panic!("presence")
                    };
                    right.expr = ir::IrExpr::Bool(true);
                }
            }
            "current-field" | "current-type" => {
                let ir::IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!("revision")
                };
                if mode == "current-field" {
                    let ir::IrExpr::Member { field, .. } = &mut value.expr else {
                        panic!("current")
                    };
                    *field = "active".into();
                } else {
                    value.ty = ResolvedType::Nullable(Box::new(value.ty.clone()));
                }
            }
            "digest-guard" => {
                let ir::IrStmt::Require { cond, .. } = &mut effects[1] else {
                    panic!("digest guard")
                };
                cond.expr = ir::IrExpr::Bool(true);
            }
            "digest-binding" => {
                let ir::IrStmt::Let { value, .. } = &mut effects[2] else {
                    panic!("validation")
                };
                let ir::IrExpr::Member { base, .. } = &mut value.expr else {
                    panic!("digest")
                };
                base.expr = ir::IrExpr::Name("template".into());
            }
            "reference-input" => {
                let ir::IrStmt::Create { input, .. } = &mut effects[3] else {
                    panic!("Run")
                };
                let ir::IrExpr::Object(fields) = &mut input.expr else {
                    panic!("inputs")
                };
                fields[0].1.expr = ir::IrExpr::Name("template".into());
            }
            _ => unreachable!(),
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
        "current-revision.can".into(),
        SOURCE.replace("revision.outputs", "revision.number "),
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
    for(mode,source)in[
        ("missing-presence",SOURCE.replace("template.current!=null and ","")),
        ("late-presence",SOURCE.replace("  require template.active and template.current!=null and template.current.published\n  do\n","  do\n   require template.active and template.current!=null and template.current.published\n")),
        ("copy",SOURCE.replace("   create Run","   let copied=revision\n   create Run").replace("Run {revision,digest","Run {revision=copied,digest")),
        ("foreign",SOURCE.replace("generate(template:Template)","generate(template:Template,other:Template)").replace("let revision=template.current","let revision=other.current")),
    ]{let mut own=SourceDb::new();let file=own.add(format!("{mode}.can"),source);let(program,diagnostics)=check_program(&own,&[file],Some(&catalog));if diagnostics.is_empty(){let owner=symbol(&program,OWNER);assert!(matches!(program.scenario_disclosures()[&owner],ScenarioDisclosure::Declined(_)),"{mode}: original leading/current lineage only");}else{assert!(diagnostics.iter().any(|diagnostic|diagnostic.severity==canlang_compiler::diagnostic::Severity::Error),"{mode}: {diagnostics:?}");assert!(program.scenario_disclosures().is_empty());}}
}

#[test]
fn actual_current_source_stays_native_refused_until_real_nullable_field_receiver_is_released() {
    let (db, program, ir, catalog) = checked(SOURCE);
    assert!(matches!(
        program.scenario_disclosures()[&symbol(&program, OWNER)],
        ScenarioDisclosure::Complete(_)
    ));
    let raw = js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
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
    let mut result = DiagnosticResult::new("current-revision-source", "1.0", 1);
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
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{diagnostics:?}"
    );
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("current-revision.can");
    std::fs::write(&source, SOURCE).unwrap();
    let copied_catalog = scratch.path().join("native-catalog.json");
    std::fs::copy(
        native_owner().join("packages/cloudflare/dist/native-catalog.json"),
        &copied_catalog,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(copied_catalog)
        .arg(source)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report.get("modules").is_none());
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"),
        "{report}"
    );
}
