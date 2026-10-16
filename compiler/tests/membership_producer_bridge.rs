//! Lane C membership producer bridge (outcome-13): the State membership
//! producer (dispatch-membership checked occurrence + receipt exact-occurrence
//! rule) defines `active_member`, and the compiler bridge carries each
//! checked occurrence's source and selected call closure to the lowering.
//!
//! A bound observation lowers inline (`await active_member(c,...)` with its
//! source descriptor) and its builtin reference resolves to that defining
//! owner. Only genuinely unbound sources refuse, with their exact codes.
//! Mirrors the outcome-14 capture (evidence/original24-20261016.json), where
//! an unrelated IR refusal orphaned the Employees.can `staff`/`can_work`
//! observations into four `E6008` plus one catalog-external `E6007`.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::DiagnosticResult;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

const CATALOG_JSON: &str = r#"{"language_version":"1.0","catalog_version":"0.1.0","entries":[{"id":"active_member","js":"active_member","owner":"lane-03","kind":"builtin","signature":"active_member(person:user,team:Team)->bool","effects":"state-read","availability":"external"},{"id":"any","js":"any","owner":"lane-02","kind":"builtin","signature":"any(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"},{"id":"all","js":"all","owner":"lane-02","kind":"builtin","signature":"all(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"},{"id":"count","js":"count","owner":"lane-02","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"pure","availability":"implemented"},{"id":"first","js":"first","owner":"lane-02","kind":"builtin","signature":"first(domain:ordered C<T>)->T?","effects":"pure","availability":"implemented"},{"id":"choose","js":"choose","owner":"lane-02","kind":"builtin","signature":"choose(condition:bool,yes:T,no:T)->T","effects":"pure","availability":"implemented"},{"id":"trim","js":"trim","owner":"lane-02","kind":"builtin","signature":"trim(value:S)->text","effects":"pure","availability":"implemented"},{"id":"starts_with","js":"starts_with","owner":"lane-02","kind":"builtin","signature":"starts_with(value:S,prefix:text)->bool","effects":"pure","availability":"implemented"},{"id":"format","js":"format","owner":"lane-02","kind":"builtin","signature":"format(template:text,values:closed object of Display)->text; format(descriptor:message,locale:locale?)->text","effects":"pure","availability":"implemented"},{"id":"money","js":"money","owner":"lane-02","kind":"builtin","signature":"money(value:int,currency:currency)->money; money(value:decimal,currency:currency)->money","effects":"pure","availability":"implemented"},{"id":"date","js":"date","owner":"lane-02","kind":"builtin","signature":"date(value:text)->date","effects":"pure","availability":"implemented"}]}"#;

/// `staff`/`can_work` mirror Employees.can: `active_member` inside
/// `any(...)`, exported cross-package and consumed through a helper chain,
/// collection-domain `all(...)`, read policies, a scenario and a page.
const STAFF_CONSUMED: &str = "app Inv uses=[shop]\npackage lib\n Given\n  export Worker {account:user,active:bool,home:text}\n  policy Worker read=members\n  export derive staff(person:user):bool = any(Worker as w,w.account==person and w.active and active_member(person,team))\n  export derive can_work(person:user,location:text):bool = any(Worker as w,w.account==person and w.active and active_member(person,team) and w.home==location)\n When\n Then\npackage shop\n use lib {staff,can_work}\n Given\n  Entry {owner:user,site:text,sites:text[]}\n  derive crew(person:user,place:text):bool = can_work(person,place)\n  policy Entry read=members and staff(actor)\n  policy Entry read=members and crew(actor,row.site)\n  policy Entry read=members and all(row.sites as location,can_work(actor,location))\n When\n  scenario touch(entry:Entry) by=members\n   require staff(actor)\n   do let x = 1\n Then\n  page /entries title=\"Entries\"\n   list Entry as e where actor!=null and staff(actor)\n    text \"hi\"\n";

/// The defining `employee` package in its own file, like shared/Employees.can
/// at composition file 10, sharing the global package index with consumers.
const EMPLOYEES_FILE: &str = "package employee\n Given\n  export Worker {account:user,active:bool,home:text}\n  policy Worker read=members\n  export derive staff(person:user):bool = any(Worker as w,w.account==person and w.active and active_member(person,team))\n  export derive can_work(person:user,location:text):bool = any(Worker as w,w.account==person and w.active and active_member(person,team) and w.home==location)\n When\n Then\n";

/// Consumer file with the same membership reads plus one unrelated hook
/// refusal (`actor` without native hook context): analysis stays clean while
/// IR reports `hook contextual binding`, exactly the composition's condition.
const CONSUMER_FILE: &str = "app Inv uses=[shop]\npackage shop\n use employee {staff,can_work}\n Given\n  Entry {owner:user,site:text,sites:text[]}\n  derive crew(person:user,place:text):bool = can_work(person,place)\n  policy Entry read=members and staff(actor)\n  policy Entry read=members and crew(actor,row.site)\n  policy Entry read=members and all(row.sites as location,can_work(actor,location))\n  Hook {title:text}\n When\n  scenario touch(entry:Entry) by=members\n   require staff(actor)\n   do let x = 1\n  scenario h on=Hook.create\n   do\n    let value=actor\n Then\n  page /entries title=\"Entries\"\n   list Entry as e where actor!=null and staff(actor)\n    text \"hi\"\n";

/// Second app in the same compilation consuming the same defining package,
/// mirroring the multi-app composition where many apps share `employee`.
const SECOND_APP_FILE: &str = "app Other uses=[desk]\npackage desk\n use employee {staff}\n Given\n  Ticket {owner:user}\n  policy Ticket read=members and staff(actor)\n When\n  scenario open(ticket:Ticket) by=members\n   require staff(actor)\n   do let x = 1\n Then\n  page /tickets title=\"Tickets\"\n   list Ticket as t where actor!=null and staff(actor)\n    text \"hi\"\n";

fn load_catalog_text(entries: &str) -> (tempfile::TempDir, Catalog) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    std::fs::write(&path, entries).unwrap();
    let mut anchor = SourceDb::new();
    let id = anchor.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: dir.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (dir, catalog.unwrap())
}

fn load_test_catalog() -> (tempfile::TempDir, Catalog) {
    load_catalog_text(CATALOG_JSON)
}

fn check_sources(sources: &[(&str, &str)], catalog: &Catalog) -> (SourceDb, CheckedProgram) {
    let mut db = SourceDb::new();
    let files: Vec<_> = sources
        .iter()
        .map(|(path, text)| db.add((*path).into(), (*text).into()))
        .collect();
    let (program, diagnostics) = check_program(&db, &files, Some(catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program)
}

fn ir_diagnostics(db: &SourceDb, program: &CheckedProgram, catalog: &Catalog) -> Vec<String> {
    let (_ir, diagnostics) = ir::build(program, db, Some(catalog));
    diagnostics
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect()
}

fn emit_js(db: &SourceDb, program: &CheckedProgram, catalog: &Catalog) -> (String, Vec<String>) {
    let mut js = String::new();
    let mut codes = Vec::new();
    for native_receipts in [false, true] {
        let mut result = DiagnosticResult::new(
            "membership-producer-bridge",
            LANGUAGE_VERSION,
            SCHEMA_VERSION,
        );
        result.add_sources(db);
        result.complete = true;
        let mut options = EmitOptions::new();
        options.native_scenario_receipts = native_receipts;
        let (artifact, diagnostics) = emit(
            program,
            &EmitSources {
                db,
                result: &result,
                catalog: Some(catalog),
                options,
            },
        );
        for module in &artifact.modules {
            js.push_str(&module.js);
            js.push('\n');
        }
        for diagnostic in &diagnostics {
            codes.push(format!(
                "{}:{}:{}",
                if native_receipts { "receipts" } else { "plain" },
                diagnostic.code,
                diagnostic.message
            ));
        }
    }
    (js, codes)
}

fn membership_codes(codes: &[String]) -> Vec<&String> {
    codes
        .iter()
        .filter(|code| code.contains("membership observation") || code.contains("active_member"))
        .collect()
}

/// The composition regression: an unrelated IR refusal must not orphan
/// exactly-bound membership observations, and bound references resolve to
/// their defining State producer instead of the catalog-external marker.
#[test]
fn unrelated_ir_refusal_keeps_bound_observations() {
    let (_dir, catalog) = load_test_catalog();
    let (db, program) = check_sources(
        &[
            ("employees.can", EMPLOYEES_FILE),
            ("consumer.can", CONSUMER_FILE),
        ],
        &catalog,
    );
    let ir_codes = ir_diagnostics(&db, &program, &catalog);
    assert!(
        ir_codes
            .iter()
            .any(|code| code.contains("hook contextual binding")),
        "probe needs its unrelated IR refusal: {ir_codes:?}"
    );
    let (js, codes) = emit_js(&db, &program, &catalog);
    let membership = membership_codes(&codes);
    assert!(
        membership.is_empty(),
        "bound observations resolve, got: {membership:?} (all: {codes:?})"
    );
    assert!(
        ir_codes
            .iter()
            .any(|code| code.contains("hook contextual binding"))
            && codes
                .iter()
                .any(|code| code.contains("hook contextual binding")),
        "the unrelated refusal is retained, not swallowed: {codes:?}"
    );
    assert!(
        js.contains("await active_member(c,"),
        "observations lower inline with their source closure"
    );
}

/// Clean closure: bound observations lower with no diagnostics at all.
#[test]
fn clean_closure_resolves_defining_owner() {
    let (_dir, catalog) = load_test_catalog();
    let (db, program) = check_sources(&[("probe.can", STAFF_CONSUMED)], &catalog);
    assert!(ir_diagnostics(&db, &program, &catalog).is_empty());
    let (js, codes) = emit_js(&db, &program, &catalog);
    assert!(codes.is_empty(), "no diagnostics, got: {codes:?}");
    assert!(js.contains("await active_member(c,"), "observations lower");
}

/// Multi-app closure sharing one defining package.
#[test]
fn multi_app_closure_resolves_defining_owner() {
    let (_dir, catalog) = load_test_catalog();
    let (db, program) = check_sources(
        &[
            ("employees.can", EMPLOYEES_FILE),
            ("consumer.can", CONSUMER_FILE),
            ("other.can", SECOND_APP_FILE),
        ],
        &catalog,
    );
    let (js, codes) = emit_js(&db, &program, &catalog);
    let membership = membership_codes(&codes);
    assert!(
        membership.is_empty(),
        "bound observations resolve, got: {membership:?} (all: {codes:?})"
    );
    assert!(js.contains("await active_member(c,"), "observations lower");
}

/// Full partner-closure shape (the recorded `staff`/`can_work` derives with
/// their cross-package `all(...)` consumers): membership resolves even
/// beside unrelated refusals owned by other lanes.
#[test]
fn partner_closure_resolves_membership() {
    let (_dir, catalog) = load_test_catalog();
    let source = include_str!("fixtures/original-partner-policy-closure.can");
    let (db, program) = check_sources(&[("partner-closure.can", source)], &catalog);
    let (js, codes) = emit_js(&db, &program, &catalog);
    let membership = membership_codes(&codes);
    assert!(
        membership.is_empty(),
        "bound observations resolve, got: {membership:?} (all: {codes:?})"
    );
    assert!(js.contains("await active_member(c,"), "observations lower");
}

/// Neighbor shape: derived read policy plus an event-handler observation
/// (`scenario observed on=Received`), mirroring the membership codegen
/// coverage. The handler observation binds to the State producer too.
#[test]
fn handler_observation_binds() {
    let (_dir, catalog) = load_test_catalog();
    let source = "app Membership\nGiven\n Person {account:user}\n event Received {person:user}\n derive can_use(person:user?):bool = person!=null and active_member(person,team)\n policy Person read=can_use(actor)\nWhen\n scenario run(person:user) -> bool by=members\n  require can_use(person)\n  do return true\n scenario observed on=Received\n  do\n   if not active_member(event.person,team)\n    require false\nThen\n page /people title=\"People\"\n  list Person as person where can_use(person.account)\n   text row.account\n";
    let (db, program) = check_sources(&[("probe.can", source)], &catalog);
    let (js, codes) = emit_js(&db, &program, &catalog);
    assert!(codes.is_empty(), "handler observation resolves: {codes:?}");
    assert!(js.contains("await active_member(c,"), "observation lowers");
}

/// Neighbor shape: `active_member` inside a read-scenario `require`, like
/// the saved-handler packet bodies. The require observation binds.
#[test]
fn read_require_observation_binds() {
    let (_dir, catalog) = load_test_catalog();
    let source = "app R\nGiven\n Entry {owner:user}\n role recruiter\nWhen\n scenario check(entry:Entry) read=true -> bool by=recruiter\n  do\n   require active_member(actor,team)\n   return true\nThen\n";
    let (db, program) = check_sources(&[("probe.can", source)], &catalog);
    let (js, codes) = emit_js(&db, &program, &catalog);
    assert!(codes.is_empty(), "require observation resolves: {codes:?}");
    assert!(js.contains("await active_member(c,"), "observation lowers");
}

/// Neighbor shape: a saved-handler packet body (scenario require with a
/// `first(...)` domain query plus enum `match`), wrapped in its owning
/// context like the enum-handler runtime coverage minus examples. The
/// installed-catalog handler occurrence binds to the State producer; only
/// genuinely unbound positions refuse.
#[test]
fn packet_handler_observation_binds() {
    let (_dir, catalog) = load_test_catalog();
    let handler = "  ## Added bounded comparison handler; PROPOSED enum-only match syntax; uncompiled evidence.\n  scenario stage_text(candidate:Candidate) read=true -> text by=recruiter\n   do\n    let person=actor\n    let location=candidate.parent.location\n    let worker=first(Employee as e where e.user==person and e.active)\n    require worker!=null and active_member(person,team) and (worker.operator_wide or worker.home==location or location in worker.locations)\n    let state=candidate.stage\n    match state\n     case applied\n      return \"Applied\"\n     case interview\n      return \"Interview\"\n     case offer\n      return \"Offer\"\n     case hired\n      return \"Hired\"\n     case rejected\n      return \"Rejected\"\n     case withdrawn\n      return \"Withdrawn\"\n";
    let source = format!(
        "app CanHire uses=[hire]\npackage rent_catalog\n Given\n  export Location {{name:text}}\n When\n Then\npackage employee\n use rent_catalog {{Location}}\n Given\n  export Employee {{user:user unique,home:Location,locations:Location[],operator_wide:bool=false,active:bool=true}}\n When\n Then\npackage hire\n use rent_catalog {{Location}}\n use employee {{Employee}}\n Given\n  role recruiter\n  Vacancy {{location:Location}}\n  Candidate in Vacancy {{stage:enum(applied,interview,offer,hired,rejected,withdrawn)=applied}}\n When\n{handler} Then\n"
    );
    let (db, program) = check_sources(&[("probe.can", &source)], &catalog);
    let (js, codes) = emit_js(&db, &program, &catalog);
    let membership = membership_codes(&codes);
    assert!(
        membership.is_empty(),
        "handler occurrence resolves, got: {membership:?} (all: {codes:?})"
    );
    assert!(js.contains("await active_member(c,"), "observation lowers");
}

/// Denied producer: a `planned` membership builtin never checks, with the
/// exact owner-naming code — the bridge has nothing to bind.
#[test]
fn planned_builtin_stays_denied() {
    let planned = CATALOG_JSON.replace(
        "\"effects\":\"state-read\",\"availability\":\"external\"",
        "\"effects\":\"state-read\",\"availability\":\"planned\"",
    );
    assert_ne!(planned, CATALOG_JSON);
    let (_dir, catalog) = load_catalog_text(&planned);
    let mut db = SourceDb::new();
    let id = db.add("probe.can".into(), STAFF_CONSUMED.into());
    let (_program, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|d| d.code == "E6001" && d.message.contains("active_member")),
        "planned producer stays denied with its exact code: {diagnostics:?}"
    );
}

/// Tampered bytes: emitting a checked program against changed source bytes
/// refuses at the cohort gate before any membership lowering.
#[test]
fn tampered_source_refuses_cohort() {
    let (_dir, catalog) = load_test_catalog();
    let (db, program) = check_sources(&[("probe.can", STAFF_CONSUMED)], &catalog);
    let mut tampered = SourceDb::new();
    tampered.add("probe.can".into(), format!("{STAFF_CONSUMED} "));
    let mut result = DiagnosticResult::new(
        "membership-producer-bridge",
        LANGUAGE_VERSION,
        SCHEMA_VERSION,
    );
    result.add_sources(&tampered);
    result.complete = true;
    let (artifact, diagnostics) = emit(
        &program,
        &EmitSources {
            db: &tampered,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    assert!(
        diagnostics.iter().any(|d| d.code == "E6011"),
        "tampered bytes refuse at the cohort gate: {diagnostics:?}"
    );
    assert!(
        !artifact
            .modules
            .iter()
            .any(|module| module.js.contains("await active_member(c,")),
        "no membership lowering past a refused cohort"
    );
    drop(db);
}
