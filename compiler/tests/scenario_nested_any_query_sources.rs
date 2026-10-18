//! Derive-nested `any` disclosure: a navigation-domain query inside a derive
//! body called from a Require guard completes with sealed lineage, while a
//! derive-result argument (not the original parameter) still declines.
//! A guard-level nullable parameter field compared against the same model's
//! parameter (`booking.table==table`) completes; against a derive result it
//! still declines.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

// The `available` shape mirrors the cafe reservation guard: a derive-param
// rooted `table.parent.Booking` navigation domain with row-identity,
// record-equality, literal-membership, null-check and pure `overlaps`
// conjuncts. `try_direct` covers the direct-guard null-comparison dual.
const NESTED: &str = r#"app Probe uses=[probe]
package probe
 Given
  export Cafe { name:text }
  export Table in Cafe { seats:int, active:bool=true }
  export Booking in Cafe { table:Table?, state:enum(waiting,reserved,seated)=waiting, from:datetime?, until:datetime? }
  export derive available(table:Table,from:datetime,until:datetime,skip:Booking?):bool = table.active and not any(table.parent.Booking as booking,booking!=skip and booking.table==table and booking.state in [reserved,seated] and booking.from!=null and booking.until!=null and overlaps(from,until,booking.from,booking.until))
  export derive pick(table:Table):Table = table
 When
  scenario try(table:Table,from:datetime,until:datetime,skip:Booking?)->bool by=members
   require available(table,from,until,skip)
   do
    return true
  scenario try_direct(booking:Booking,table:Table)->bool by=members
   require not any(booking.parent.Booking as other,other.table==table)
   do
    return true
  scenario try_now(table:Table,until:datetime,booking:Booking)->bool by=members
   require available(table,now,until,booking)
   do
    return true
  scenario try_copy(table:Table,from:datetime,until:datetime,skip:Booking?)->bool by=members
   require available(pick(table),from,until,skip)
   do
    return true
  scenario try_param_field(booking:Booking,table:Table)->bool by=members
   require (booking.state==waiting or booking.table==table)
   do
    return true
  scenario try_param_field_unsealed(booking:Booking,table:Table)->bool by=members
   require booking.table==pick(table)
   do
    return true
 Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn checked() -> CheckedProgram {
    let mut db = SourceDb::new();
    let files = vec![db.add("app.can".into(), NESTED.into())];
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &files, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    program
}

fn disclosure<'a>(program: &'a CheckedProgram, name: &str) -> &'a ScenarioDisclosure {
    let symbol = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == name)
        .unwrap();
    program.scenario_disclosures().get(&symbol.id).unwrap()
}

#[test]
fn nested_any_query_completes_with_sealed_lineage() {
    let program = checked();
    assert!(
        matches!(disclosure(&program, "probe.try"), ScenarioDisclosure::Complete(_)),
        "derive-nested navigation query completes"
    );
    assert!(
        matches!(
            disclosure(&program, "probe.try_direct"),
            ScenarioDisclosure::Complete(_)
        ),
        "direct navigation query with null comparisons completes"
    );
    assert!(
        matches!(
            disclosure(&program, "probe.try_now"),
            ScenarioDisclosure::Complete(_)
        ),
        "nested query with a sealed `now` argument completes"
    );
    assert!(
        matches!(
            disclosure(&program, "probe.try_param_field"),
            ScenarioDisclosure::Complete(_)
        ),
        "guard-level nullable parameter field against its model parameter completes"
    );
    let ScenarioDisclosure::Declined(decline) =
        disclosure(&program, "probe.try_param_field_unsealed")
    else {
        panic!("parameter field against a derive result must not complete");
    };
    assert!(
        decline.reason.contains("nullable reference selection or comparison"),
        "unsealed parameter-field comparison keeps the refusal, got: {}",
        decline.reason
    );
}

#[test]
fn nested_any_query_refuses_unsealed_arguments() {
    let program = checked();
    let ScenarioDisclosure::Declined(decline) = disclosure(&program, "probe.try_copy") else {
        panic!("derive-result argument must not acquire the sealed lineage");
    };
    assert!(
        decline.reason.contains("query closure is not supported"),
        "unsealed nested query falls through to the query refusal, got: {}",
        decline.reason
    );
}
