//! Required stored-reference/scalar pairing and native source correspondence.
use super::*;
use crate::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use crate::analysis::{CheckedProgram, check_program};
use crate::codegen::{EmitOptions, EmitSources, emit};
use crate::diagnostic::DiagnosticResult;
use std::path::{Path, PathBuf};

const SOURCE: &str = include_str!("../../tests/fixtures/source-profile-scalars.can");
const HASH: &str = "06e8633f8d0b8d1b7b57333447a4bda47db36676db8b43bab5259f6064693995";
const OWNER: &str = "SourceProfileScalars.ask";

fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("source-profile-scalars.can".into(), SOURCE.into());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let primary = PathBuf::from("/Users/vince/Projects/canlang");
    let primary_catalog = primary.join("packages/cloudflare/dist/native-catalog.json");
    let path = if primary_catalog.is_file() {
        primary_catalog
    } else {
        root.join("packages/cloudflare/dist/native-catalog.json")
    };
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = super::super::ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}
fn owner(ir: &IrProgram) -> &IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == OWNER)
        .unwrap()
}

// Borrow the actual nine owning outer Member occurrences. The unchanged
// fixture has a guard, two reserve reads and six authored Create operands.
fn leaves(ir: &IrProgram) -> Vec<&TypedExpr> {
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner(ir).kind
    else {
        panic!("scenario")
    };
    let IrStmt::Require { cond, .. } = &guards[0] else {
        panic!("active guard")
    };
    let IrStmt::Let { value, .. } = &effects[0] else {
        panic!("reserve")
    };
    let IrExpr::Binary { left, right, .. } = &value.expr else {
        panic!("reserve leaves")
    };
    let IrStmt::Create { input, .. } = &effects[1] else {
        panic!("Run inputs")
    };
    let IrExpr::Object(fields) = &input.expr else {
        panic!("authored inputs")
    };
    let mut leaves = vec![cond, left.as_ref(), right.as_ref()];
    leaves.extend(fields[2..].iter().map(|(_, value)| value));
    leaves
}

#[test]
fn actual_required_profile_pairs_keep_original_field_ids_roles_and_source_order() {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), HASH);
    let (db, _, ir, _) = fixture();
    let item = owner(&ir);
    let ScenarioDisclosure::Complete(proof) = &ir.scenario_disclosures[&item.id] else {
        panic!("source Complete")
    };
    let [returned] = proof.returns.as_slice() else {
        panic!("one original source return")
    };
    let [created] = proof
        .source_facts
        .as_ref()
        .unwrap()
        .creates
        .as_deref()
        .unwrap()
    else {
        panic!("one original Create")
    };
    assert!(
        checked_created_statements(&ir, item, proof, created, &db).is_some(),
        "the actual source statement consumer uses the checked Profile pairs"
    );
    let expressions = leaves(&ir);
    assert_eq!(expressions.len(), 9);
    let mut names = Vec::new();
    let mut ids = HashSet::new();
    for (index, expression) in expressions.iter().enumerate() {
        let (reference, scalar) = checked_profile_scalar_pair(&ir, item, expression, &db)
            .expect("actual borrowed source pair");
        names.push(scalar.field_name.as_str());
        assert!(ids.insert(&reference.id) && ids.insert(&scalar.id));
        assert!(
            returned
                .dependencies
                .iter()
                .any(|original| std::ptr::eq(original, reference))
        );
        assert!(
            returned
                .dependencies
                .iter()
                .any(|original| std::ptr::eq(original, scalar))
        );
        let reference_position = returned
            .dependencies
            .iter()
            .position(|original| std::ptr::eq(original, reference))
            .unwrap();
        let scalar_position = returned
            .dependencies
            .iter()
            .position(|original| std::ptr::eq(original, scalar))
            .unwrap();
        assert_eq!(scalar_position, reference_position + 1);
        let role = if index == 0 {
            DependencyRole::Control
        } else {
            DependencyRole::Data
        };
        assert_eq!(reference.role, role);
        assert_eq!(scalar.role, role);
        assert_eq!(reference.field_name, "profile");
        assert_eq!(reference.model_name, "SourceProfileScalars.Branch");
        assert_eq!(reference.type_id, "SourceProfileScalars.Profile");
        assert_eq!(scalar.model_name, "SourceProfileScalars.Profile");
        assert_eq!(scalar.ty, expression.ty);
        assert!(reference.calls.is_empty() && scalar.calls.is_empty());
        assert!(reference.query_id.is_none() && scalar.query_id.is_none());
        assert_eq!(reference.source, scalar.source);
        assert_eq!(scalar.source, proof.source);
        let IrExpr::Member { base, field } = &expression.expr else {
            panic!("outer leaf")
        };
        assert_eq!(&scalar.field_name, field);
        assert_eq!(base.span.start, reference.node.start);
        assert_eq!(base.span.end, reference.node.end);
        assert_eq!(expression.span.start, scalar.node.start);
        assert_eq!(expression.span.end, scalar.node.end);
    }
    assert_eq!(
        names,
        [
            "active",
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
    assert_eq!(
        ids.len(),
        18,
        "each getter/scalar source occurrence remains distinct"
    );
}

#[test]
fn mismatched_source_role_order_schema_binder_nullable_or_copied_pairs_refuse() {
    let (db, _, ir, _) = fixture();
    let item = owner(&ir);
    let leaf = leaves(&ir)[3];
    let (reference, scalar) = checked_profile_scalar_pair(&ir, item, leaf, &db).unwrap();
    let detached = leaf.clone();
    assert!(
        checked_profile_scalar_pair(&ir, item, &detached, &db).is_none(),
        "same-span detached expression is not the owning occurrence"
    );
    let foreign = ir.clone();
    assert!(
        checked_profile_scalar_pair(&ir, item, leaves(&foreign)[3], &db).is_none(),
        "another IR does not supply the original occurrence"
    );
    assert!(
        checked_profile_scalar_pair(&ir, owner(&foreign), leaves(&foreign)[3], &db).is_none(),
        "another IR cannot supply the owning scenario either"
    );
    for mode in [
        "source",
        "role",
        "order",
        "missing-reference",
        "schema",
        "unselected-schema",
        "binder",
        "reference",
        "nullable",
        "copy",
    ] {
        let mut changed = ir.clone();
        let id = owner(&changed).id;
        if matches!(mode, "source" | "role" | "order" | "missing-reference") {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&id).unwrap()
            else {
                panic!("Complete")
            };
            let dependencies = &mut proof.returns[0].dependencies;
            let ref_position = dependencies
                .iter()
                .position(|read| read.id == reference.id)
                .unwrap();
            let leaf_position = dependencies
                .iter()
                .position(|read| read.id == scalar.id)
                .unwrap();
            match mode {
                "source" => dependencies[ref_position].source.sha256 = "0".repeat(64),
                "role" => dependencies[ref_position].role = DependencyRole::Control,
                "order" => dependencies.swap(ref_position, leaf_position),
                _ => {
                    dependencies.remove(ref_position);
                }
            }
        } else if mode == "schema" || mode == "unselected-schema" {
            let field = if mode == "schema" {
                scalar.field
            } else {
                changed
                    .items
                    .iter()
                    .find(|item| item.canonical == "SourceProfileScalars.Profile.name")
                    .unwrap()
                    .id
            };
            let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                panic!("real Profile field")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Int));
        } else if mode == "binder" {
            let IrItemKind::Scenario { params, .. } = &changed.items[id.0 as usize].kind else {
                panic!("scenario")
            };
            let param = params[0];
            let IrItemKind::Param { index, .. } = &mut changed.items[param.0 as usize].kind else {
                panic!("actual Branch parameter")
            };
            *index = 1;
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[id.0 as usize].kind
            else {
                panic!("scenario")
            };
            let IrStmt::Create { input, .. } = &mut effects[1] else {
                panic!("actual Create")
            };
            let IrExpr::Object(fields) = &mut input.expr else {
                panic!("inputs")
            };
            let IrExpr::Member { base, .. } = &mut fields[2].1.expr else {
                panic!("system_prompt")
            };
            if mode == "nullable" {
                base.ty = ResolvedType::Nullable(Box::new(base.ty.clone()));
            } else {
                let IrExpr::Member {
                    base: branch,
                    field,
                } = &mut base.expr
                else {
                    panic!("original getter")
                };
                if mode == "reference" {
                    *field = "origin".into();
                } else {
                    branch.expr = IrExpr::Name("copied".into());
                }
            }
        }
        assert!(
            checked_profile_scalar_pair(&changed, owner(&changed), leaves(&changed)[3], &db)
                .is_none(),
            "{mode}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "source-profile-scalars.can".into(),
        SOURCE.replace("system_prompt:text", "system_prompt:int "),
    );
    assert!(
        checked_profile_scalar_pair(&ir, item, leaf, &stale).is_none(),
        "source/schema identity changed"
    );
}

#[test]
fn original_profile_pairs_publish_native_source_but_unprepared_source_still_refuses() {
    let (db, program, ir, catalog) = fixture();
    for leaf in leaves(&ir) {
        assert!(checked_profile_scalar_pair(&ir, owner(&ir), leaf, &db).is_some());
    }
    let models = super::super::js::Emitter::new(&ir).collect_models();
    let collect = |models: &[JsModel]| {
        collect_native_scenario_receipt(
            &ir,
            owner(&ir),
            models,
            "$can$m$536f7572636550726f66696c655363616c617273.mjs",
            None,
            NativeReceiptSources {
                source_context: None,
                db: Some(&db),
                send_guards: None,
                query_plan: None,
            },
        )
    };
    assert!(
        collect(&models).is_some(),
        "genuine emitted descriptor baseline"
    );
    let mut altered = models.clone();
    let profile = altered
        .iter_mut()
        .find(|model| model.name == "SourceProfileScalars.Profile")
        .unwrap();
    profile
        .fields
        .iter_mut()
        .find(|field| field.name == "name")
        .unwrap()
        .name = "display_name".into();
    assert!(checked_profile_scalar_pair(&ir, owner(&ir), leaves(&ir)[3], &db).is_some());
    assert!(
        collect(&altered).is_none(),
        "an unselected Profile field cannot alter the original full native schema"
    );
    let raw = super::super::js::emit_program_with_native_source_receipts(&ir, true, &db);
    assert!(
        raw.diagnostics.is_empty(),
        "original checked source: {:?}",
        raw.diagnostics
    );
    assert!(
        raw.operations
            .iter()
            .find(|operation| operation.name == OWNER)
            .unwrap()
            .disclosure
            .is_some()
    );
    let mut result = DiagnosticResult::new("profile-pair", "1.0", 1);
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
        diagnostics.is_empty(),
        "released producer preparation: {diagnostics:?}"
    );
    let unprepared = super::super::js::emit_program_with_native_receipts(&ir, true);
    assert!(
        unprepared
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
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
