//! Dispatch fence persistence: post-send sets may persist sealed
//! send-result envelope fields (`delivery.id`) alongside other fields.
//! The send binding must be flow-visible (effects disclose in order),
//! the leaf comes from the closed `DeliveryResult` envelope with its
//! checker-resolved scalar type; unknown leaves, use-before-send and
//! type mismatches keep their precise check-phase refusals.
//!
//! These tests assert at the fixed layer (analysis disclosure +
//! check). Full native-receipt emission needs catalog-backed guard
//! preparation, exercised through the real CLI (`compile
//! --native-scenario-receipts` yields a clean artifact for both
//! positive shapes below).
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const RETRY_SHAPE: &str = "app RetryShape
use std {EmailV1 as Mail} from=deployment.mail
Given
 M {f:text?,state:enum(none,pending,released,failed,unknown)=none}
 policy M read=members
When
 scenario go(row:M,enabled:bool) by=members
  do
   send Mail.send {to=\"r@example.test\",subject=\"S\",body=\"B\"} when=enabled as delivery
   set row {f=delivery.id,state=pending}
Then
";

const ID_ONLY_SHAPE: &str = "app IdOnlyShape
use std {EmailV1 as Mail} from=deployment.mail
Given
 M {f:text?}
 policy M read=members
When
 scenario go(row:M,enabled:bool) by=members
  do
   send Mail.send {to=\"r@example.test\",subject=\"S\",body=\"B\"} when=enabled as delivery
   set row {f=delivery.id}
Then
";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_catalog() -> PathBuf {
    let public = Path::new("/Users/vince/Projects/canlang");
    let base = if public
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        public.into()
    } else {
        root()
    };
    base.join("packages/cloudflare/dist/native-catalog.json")
}

fn disclose(source: &str) -> (Vec<Diagnostic>, Vec<Diagnostic>, bool) {
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source.into());
    let path = native_catalog();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, check_diagnostics) = check_program(&db, &[file], Some(&catalog));
    if !check_diagnostics.is_empty() {
        return (check_diagnostics, Vec::new(), false);
    }
    let (ir, ir_diagnostics) = ir::build(&program, &db, Some(&catalog));
    if !ir_diagnostics.is_empty() {
        return (Vec::new(), ir_diagnostics, false);
    }
    let complete = ir.items.iter().any(|item| {
        item.canonical.ends_with(".go")
            && matches!(
                ir.scenario_disclosures.get(&item.id),
                Some(ScenarioDisclosure::Complete(_))
            )
    });
    (Vec::new(), Vec::new(), complete)
}

#[test]
fn send_result_id_persists_beside_enum_literal() {
    let (check, ir, complete) = disclose(RETRY_SHAPE);
    assert!(check.is_empty(), "{check:?}");
    assert!(ir.is_empty(), "{ir:?}");
    assert!(complete, "retry shape discloses completely");
}

#[test]
fn send_result_id_persists_alone() {
    let (check, ir, complete) = disclose(ID_ONLY_SHAPE);
    assert!(check.is_empty(), "{check:?}");
    assert!(ir.is_empty(), "{ir:?}");
    assert!(complete, "id-only shape discloses completely");
}

#[test]
fn unknown_delivery_leaf_stays_refused() {
    let (check, _, _) = disclose(&ID_ONLY_SHAPE.replace("delivery.id", "delivery.bogus"));
    assert!(
        check.iter().any(|diagnostic| diagnostic.code == "E2013"),
        "{check:?}"
    );
}

#[test]
fn delivery_id_into_int_stays_refused() {
    let source = ID_ONLY_SHAPE
        .replace("M {f:text?}", "M {f:text?,n:int=0}")
        .replace("set row {f=delivery.id}", "set row {n=delivery.id}");
    let (check, _, _) = disclose(&source);
    assert!(
        check.iter().any(|diagnostic| diagnostic.code == "E3001"),
        "{check:?}"
    );
}
