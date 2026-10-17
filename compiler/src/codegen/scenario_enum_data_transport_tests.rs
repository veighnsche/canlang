//! Retained-facts tamper coverage for the plain enum data transport.
//!
//! `checked_plain_enum_data_transport` admits a reused-enum data read only
//! when the nominal enum path pins through the declaring owner Field item
//! (canonical plus cases) and the read-field descriptor carries the same
//! sealed cases. These units hold the original checked facts fixed and
//! mutate only the retained IR copy or the descriptor struct: a forged
//! owner canonical, widened owner cases, or narrowed descriptor values
//! must each refuse, through the defining helper and through the full
//! `collect_native_scenario_receipt_with_feasibility` collector.
use super::*;
use crate::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use crate::analysis::{CheckedProgram, SymbolId, check_program};
use std::path::{Path, PathBuf};

const SOURCE: &str = r#"app EnumTamperProbe
Given
 P {v:int}
 C in P {account:user,role:enum(administrator,booker)}
 D in P {account:user,role:C.role,w:int}
 I in P {role:C.role}
 policy P read=members fields=v
 policy C read=members fields=parent,account,role
 policy D read=members fields=parent,account,role,w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role
 crud D by=members fields=parent,account,role,w
 crud I by=members fields=parent,role
 scenario go(p:P,i:I) by=members
  do
   let c=first(p.C as c where c.account==actor and c.role==i.role order=c.id)
   require c!=null
   create D {parent=p,account=actor,role=i.role,w=1} as d
Then
"#;

const TRANSPORT: &str = "enum(administrator,booker)";
const NOMINAL: &str = "EnumTamperProbe.C.role";

fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("enum-tamper-probe.can".into(), SOURCE.into());
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

fn owner_item<'a>(ir: &'a IrProgram, owner: SymbolId) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.id == owner)
        .expect("retained owner item")
}

fn owner_id(ir: &IrProgram) -> SymbolId {
    ir.items
        .iter()
        .find(|item| item.canonical == NOMINAL)
        .expect("declaring enum field")
        .id
}

fn owner_cases(ir: &IrProgram, owner: SymbolId) -> Vec<String> {
    let field = owner_item(ir, owner);
    let IrItemKind::Field {
        ty: IrType::Known(ResolvedType::Enum { cases, .. }),
        ..
    } = &field.kind
    else {
        panic!("declaring field carries the enum");
    };
    cases.clone()
}

fn owner_enum(ir: &IrProgram) -> (SymbolId, Vec<String>) {
    let owner = owner_id(ir);
    (owner, owner_cases(ir, owner))
}

fn read_descriptor(ir: &IrProgram, db: &SourceDb) -> JsModelField {
    let models = super::super::js::Emitter::source_models(ir, db).expect("emitter models");
    models
        .iter()
        .find(|model| model.name == "EnumTamperProbe.I")
        .expect("read model")
        .fields
        .iter()
        .find(|field| field.name == "role")
        .expect("read field")
        .clone()
}

fn honest_transport(ir: &IrProgram, db: &SourceDb) -> Option<String> {
    let (owner, cases) = owner_enum(ir);
    checked_plain_enum_data_transport(ir, NOMINAL, &cases, owner, &read_descriptor(ir, db))
}

#[test]
fn honest_reused_enum_read_transports_sealed_identity() {
    let (db, _program, ir, _catalog) = fixture();
    assert_eq!(
        honest_transport(&ir, &db),
        Some(TRANSPORT.to_string()),
        "honest reused-enum read admits before any tamper"
    );
}

#[test]
fn forged_owner_canonical_refuses() {
    let (db, _program, mut ir, _catalog) = fixture();
    assert_eq!(honest_transport(&ir, &db), Some(TRANSPORT.to_string()));
    let owner = owner_id(&ir);
    // Retain the item identity; forge only the nominal path the check pins.
    let index = ir
        .items
        .iter()
        .position(|item| item.id == owner)
        .expect("retained owner item");
    ir.items[index].canonical.push_str(".forged");
    let cases = owner_cases(&ir, owner);
    assert_eq!(
        checked_plain_enum_data_transport(&ir, NOMINAL, &cases, owner, &read_descriptor(&ir, &db)),
        None,
        "nominal path no longer pins the declaring field"
    );
}

#[test]
fn widened_owner_cases_refuse() {
    let (db, _program, mut ir, _catalog) = fixture();
    assert_eq!(honest_transport(&ir, &db), Some(TRANSPORT.to_string()));
    let forged = ir
        .items
        .iter_mut()
        .find(|item| item.canonical == NOMINAL)
        .expect("declaring enum field");
    let IrItemKind::Field {
        ty: IrType::Known(ResolvedType::Enum { cases, .. }),
        ..
    } = &mut forged.kind
    else {
        panic!("declaring field carries the enum");
    };
    cases.push("billing".to_string());
    assert_eq!(
        honest_transport(&ir, &db),
        None,
        "owner cases no longer match the read type"
    );
}

#[test]
fn narrowed_descriptor_values_refuse() {
    let (db, _program, ir, _catalog) = fixture();
    assert_eq!(honest_transport(&ir, &db), Some(TRANSPORT.to_string()));
    let mut descriptor = read_descriptor(&ir, &db);
    descriptor.field = JsModelFieldType::Enum {
        values: vec!["administrator".to_string()],
    };
    let (owner, cases) = owner_enum(&ir);
    assert_eq!(
        checked_plain_enum_data_transport(&ir, NOMINAL, &cases, owner, &descriptor),
        None,
        "descriptor values no longer match the sealed cases"
    );
}

#[test]
fn nullable_read_descriptor_refuses() {
    let (db, _program, ir, _catalog) = fixture();
    assert_eq!(honest_transport(&ir, &db), Some(TRANSPORT.to_string()));
    let mut descriptor = read_descriptor(&ir, &db);
    descriptor.nullable = true;
    let (owner, cases) = owner_enum(&ir);
    assert_eq!(
        checked_plain_enum_data_transport(&ir, NOMINAL, &cases, owner, &descriptor),
        None,
        "nullable reads keep their refusal at this transport"
    );
}
