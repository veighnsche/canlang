//! Installed producer contracts (outcome 13): bound `.can` capabilities link
//! against their checked declaring producer, not the lane-02 Values catalog.
//!
//! The Values catalog only publishes pure builtins/helpers plus the
//! lane-03-owned `active_member` state-read contract. A bound import such as
//! `use rooms {RoomsV1 as Rooms} from=deployment.rooms` resolves to the
//! checked `export capability RoomsV1 version=1` declaration in the same
//! closure; DESIGN binds the adapter at deployment from that versioned
//! interface and its reachable schemas. Demanding a Values-catalog entry for
//! it (`E6007 "no producer catalog entry was consulted"`) refuses every real
//! producer. The narrow bridge accepts a bound capability whose owning
//! checked declaration pins an integer `version=`; unversioned contracts and
//! catalog-marked planned/external entries still refuse loudly.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::artifact::check_builtin_availability;
use canlang_compiler::codegen::ir::ReferencedBuiltin;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Cross-owner bound capability: the consumer binds the producer's checked
/// versioned interface (the recorded `rent_reservations.RoomsV1` shape).
const PRODUCER_CONSUMER: &str = r#"package rooms
 Given
  export capability RoomsV1 version=1
   reserve(source:text) -> Ack
  contract Ack { ok:bool }
 When
 Then
package stay
 use rooms {RoomsV1 as Rooms} from=deployment.rooms
 Given
  Booking { source:text, hold:delivery(Rooms.reserve)? }
  policy Booking read=members fields=source,hold.status
 When
  scenario hold(b:Booking) by=members
   do
    send Rooms.reserve {source=b.source} as attempt
    set b {hold=attempt}
 Then
"#;

fn unique_temp_path(stem: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("can-bound-contracts-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    dir.join(format!("{stem}-{n}.json"))
}

/// Hermetic lane-02 catalog: implemented pure builtins plus the lane-03
/// `active_member` state-read contract (external in the generic catalog).
fn lane02_catalog(active_member_availability: &str) -> (Catalog, PathBuf) {
    let path = unique_temp_path("lane02-catalog");
    std::fs::write(
        &path,
        format!(
            r#"{{"language_version":"1.0","catalog_version":"0.1.0-test","entries":[
{{"id":"count","js":"count","owner":"lane-02","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"pure","availability":"implemented"}},
{{"id":"active_member","js":"active_member","owner":"lane-03","kind":"builtin","signature":"active_member(person:user,team:Team)->bool","effects":"state-read","availability":"{active_member_availability}"}}
]}}"#,
        ),
    )
    .expect("write lane-02 catalog");
    let dir = path.parent().expect("temp dir").to_path_buf();
    let primary = Span::new(SourceId(0), 0, 0);
    let (catalog, diags) = load_catalog(&CatalogRequest {
        flag: Some(path.as_path()),
        env: None,
        cwd: dir.as_path(),
        primary,
    });
    assert!(diags.is_empty(), "lane-02 catalog loads: {diags:?}");
    (catalog.expect("catalog"), path)
}

fn check(source: &str, catalog: &Catalog) -> (SourceDb, SourceId, CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("bound-contracts.can".into(), source.into());
    let (program, diags) = check_program(&db, &[id], Some(catalog));
    (db, id, program, diags)
}

fn production_emit(
    db: &SourceDb,
    program: &CheckedProgram,
    analysis_diags: Vec<Diagnostic>,
    catalog: Option<&Catalog>,
) -> Vec<Diagnostic> {
    let mut result = DiagnosticResult::new("bound-contracts", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(db);
    result.diagnostics = analysis_diags;
    result.complete = true;
    result.finish();
    let (_, diags) = emit(
        program,
        &EmitSources {
            db,
            result: &result,
            catalog,
            options: EmitOptions::new(),
        },
    );
    diags
}

fn e6007(diags: &[Diagnostic]) -> Vec<&Diagnostic> {
    diags.iter().filter(|d| d.code == "E6007").collect()
}

/// A capability declaration whose `version=` pins no integer cannot be
/// linked: there is no versioned contract for deployment to bind. (A missing
/// `version=` is refused earlier at analysis with `E1204` and declares
/// nothing; an overflowing literal keeps the declaration with `version=None`.)
const UNVERSIONED_PRODUCER: &str = r#"package rooms
 Given
  export capability RoomsV1 version=9999999999999999999999
   reserve(source:text) -> Ack
  contract Ack { ok:bool }
 When
 Then
package stay
 use rooms {RoomsV1 as Rooms} from=deployment.rooms
 Given
  Booking { source:text }
  policy Booking read=members fields=source
 When
 Then
"#;

#[test]
fn bound_checked_capability_links_without_catalog_entry() {
    let (catalog, _path) = lane02_catalog("external");
    let (db, _id, program, analysis_diags) = check(PRODUCER_CONSUMER, &catalog);
    assert!(
        analysis_diags.is_empty(),
        "bound producer source checks clean: {analysis_diags:?}"
    );
    let emit_diags = production_emit(&db, &program, analysis_diags, Some(&catalog));
    let missing = e6007(&emit_diags);
    assert!(
        missing.is_empty(),
        "checked versioned producer links without E6007: {missing:?} (all emit: {emit_diags:?})"
    );
}

#[test]
fn unversioned_bound_capability_still_refuses() {
    let (catalog, _path) = lane02_catalog("external");
    let (db, _id, program, analysis_diags) = check(UNVERSIONED_PRODUCER, &catalog);
    let emit_diags = production_emit(&db, &program, analysis_diags, Some(&catalog));
    let missing = e6007(&emit_diags);
    assert_eq!(
        missing.len(),
        1,
        "unversioned producer keeps one E6007: {missing:?} (all emit: {emit_diags:?})"
    );
    assert!(
        missing[0].message.contains("'rooms.RoomsV1'"),
        "names the unversioned contract: {}",
        missing[0].message
    );
}

#[test]
fn active_member_external_refusal_names_lane03_producer() {
    let (catalog, _path) = lane02_catalog("external");
    let refs = [ReferencedBuiltin {
        id: "active_member".to_string(),
        span: Span::new(SourceId(0), 0, 1),
    }];
    let diags = check_builtin_availability(&refs, Some(&catalog));
    assert_eq!(diags.len(), 1, "external refuses: {diags:?}");
    assert_eq!(diags[0].code, "E6007");
    assert!(
        diags[0].message.contains("external") && diags[0].message.contains("lane-03"),
        "names producer availability: {}",
        diags[0].message
    );
}

#[test]
fn active_member_native_catalog_verifies_same_checked_contract() {
    // The installed native catalog flips only `availability` to
    // `implemented`: id, signature, effects (state-read) and owner stay
    // identical, so the same checked call verifies with no E6007.
    let (generic, _generic_path) = lane02_catalog("external");
    let (native, _native_path) = lane02_catalog("implemented");
    let generic_entry = generic.lookup("active_member").expect("generic entry");
    let native_entry = native.lookup("active_member").expect("native entry");
    assert_eq!(generic_entry.id, native_entry.id);
    assert_eq!(generic_entry.js, native_entry.js);
    assert_eq!(
        format!("{:?}", generic_entry.overloads),
        format!("{:?}", native_entry.overloads)
    );
    assert_eq!(generic_entry.effects, native_entry.effects);
    assert_eq!(generic_entry.owner, native_entry.owner);
    assert_eq!(format!("{:?}", native_entry.availability), "Implemented");
    let refs = [ReferencedBuiltin {
        id: "active_member".to_string(),
        span: Span::new(SourceId(0), 0, 1),
    }];
    let diags = check_builtin_availability(&refs, Some(&native));
    assert!(diags.is_empty(), "native catalog verifies: {diags:?}");
}
