//! B4 F4: table-example header enum elision (G4) + BDD emission parity.
//!
//! (1) A bare enum case in an `examples` header binding (`status=planned`,
//! `urgency=routine`) must elide exactly as the same case does in
//! call-arg/observation/fixture positions: no `E2001` when the name is
//! otherwise unbound and is a case of the binding's expected enum type,
//! and still `E2001` when it is not a case (parity with fixture
//! behavior). (2) Every parsed table example must emit one runnable BDD
//! row per authored data row — each row carrying exactly one of
//! `expected:` / `error:` — with no example-scoped `E6006`/`E6008`
//! omission. Emission only; the testkit runner is a later packet.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::path::{Path, PathBuf};

// --- Helpers ---------------------------------------------------------------

/// Workspace root (`compiler/tests` -> repo root).
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .expect("workspace root")
}

/// The real lane-02 catalog when its `dist` output exists, else `None`
/// (draft tests skip honestly without it).
fn real_catalog() -> Option<Catalog> {
    let path = workspace_root().join("packages/values/dist/catalog.json");
    if !path.exists() {
        return None;
    }
    let mut db = SourceDb::new();
    let id = db.add("dummy.can".to_string(), String::new());
    let request = CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(id, 0, 0),
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "real catalog loads clean: {diags:?}");
    catalog
}

/// Check one inline source with `catalog`.
fn check_src(src: &str, catalog: Option<&Catalog>) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    check_program(&db, &[id], catalog)
}

static FIXTURE_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Minimal test-only catalog for emission (pins `catalog_version` so
/// `E6007` cannot fire). The `count` shape is transcribed from the
/// DESIGN §3 notation block, as in `analysis.rs`.
fn fixture_catalog() -> Catalog {
    let json = r#"{
  "language_version": "1.0",
  "catalog_version": "2.5.0-test",
  "entries": [
    {"id": "count", "js": "count", "owner": "test", "kind": "builtin", "signature": "count(domain:C<T>)->int", "effects": "pure", "availability": "implemented"}
  ]
}"#;
    let dir = std::env::temp_dir().join(format!(
        "can-b4-examples-{}-{}",
        std::process::id(),
        FIXTURE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("catalog.json");
    std::fs::write(&path, json).unwrap();
    let mut db = SourceDb::new();
    let id = db.add("dummy.can".to_string(), String::new());
    let request = CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(id, 0, 0),
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "fixture must load clean: {diags:?}");
    catalog.expect("fixture catalog")
}

/// Load one workspace draft: database, id and text.
fn load_draft(name: &str) -> (SourceDb, SourceId, String) {
    let path = workspace_root().join("draft").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let mut db = SourceDb::new();
    let id = db.add(format!("draft/{name}"), text.clone());
    (db, id, text)
}

/// Emit under the explicit test-only incomplete-analysis acknowledgment.
fn emit_test_only(
    program: &CheckedProgram,
    db: &SourceDb,
    diags: &[Diagnostic],
    catalog: Option<&Catalog>,
) -> (
    canlang_compiler::codegen::artifact::CompileArtifact,
    Vec<Diagnostic>,
) {
    let mut result = DiagnosticResult::new("test", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(db);
    result.diagnostics = diags.to_vec();
    result.complete = false;
    result.finish();
    let sources = EmitSources {
        db,
        result: &result,
        catalog,
        options: EmitOptions::test_only(),
    };
    emit(program, &sources)
}

/// Byte span of the 1-based `occurrence`-th appearance of `needle`.
fn span_of(src: &str, needle: &str, occurrence: usize) -> (u32, u32) {
    assert!(occurrence >= 1, "occurrences are 1-based");
    let mut idx = 0;
    let mut found = 0;
    while found < occurrence {
        match src[idx..].find(needle) {
            Some(at) => {
                idx += at;
                found += 1;
                if found < occurrence {
                    idx += needle.len();
                }
            }
            None => panic!("needle {needle:?} has fewer than {occurrence} occurrences"),
        }
    }
    (idx as u32, (idx + needle.len()) as u32)
}

/// Diagnostics with `code` whose primary span covers `offset`.
fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

fn covering<'a>(diags: &'a [Diagnostic], code: &str, offset: u32) -> Vec<&'a Diagnostic> {
    diags
        .iter()
        .filter(|d| d.code == code && d.primary.start <= offset && offset < d.primary.end)
        .collect()
}

/// Split the `rows:[...]` payloads out of emitted test JS: one entry per
/// table, each a list of raw row-object strings. String-aware.
fn emitted_tables(js: &str) -> Vec<Vec<String>> {
    let bytes = js.as_bytes();
    let mut tables = Vec::new();
    let mut cursor = 0;
    while let Some(at) = js[cursor..].find("rows:[") {
        let mut i = cursor + at + "rows:[".len();
        let mut depth: i32 = 1;
        let mut in_string = false;
        let mut escaped = false;
        let start = i;
        while i < bytes.len() && depth > 0 {
            let c = bytes[i] as char;
            if in_string {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    in_string = false;
                }
            } else if c == '"' {
                in_string = true;
            } else if c == '[' || c == '{' {
                depth += 1;
            } else if c == ']' || c == '}' {
                depth -= 1;
            }
            i += 1;
        }
        // Depth counting treats `{`/`}` and `[`/`]` uniformly; the rows
        // payload ends when the counter returns to zero.
        let payload = &js[start..i.saturating_sub(1)];
        tables.push(split_rows(payload));
        cursor = i;
    }
    tables
}

/// Split one `rows:[...]` payload into top-level `{...}` row objects.
fn split_rows(payload: &str) -> Vec<String> {
    let bytes = payload.as_bytes();
    let mut rows = Vec::new();
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut start = None;
    for (i, _) in payload.char_indices() {
        let c = bytes[i] as char;
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    rows.push(payload[start.expect("row start")..=i].to_string());
                    start = None;
                }
            }
            _ => {}
        }
    }
    rows
}

/// Assert every row of every table is runnable: exactly one of
/// `,expected:` / `,error:` alongside its `values:`.
#[track_caller]
fn assert_runnable(rows: &[Vec<String>]) {
    for (table, table_rows) in rows.iter().enumerate() {
        assert!(
            !table_rows.is_empty(),
            "table {table}: parsed tables carry at least one data row"
        );
        for (row, text) in table_rows.iter().enumerate() {
            assert!(
                text.contains("values:async(c,s)=>"),
                "table {table} row {row}: carries values:\n{text}"
            );
            let has_expected = text.contains(",expected:async(c,s)=>");
            let has_error = text.contains(",error:\"");
            assert!(
                has_expected ^ has_error,
                "table {table} row {row}: runnable (expected XOR error):\n{text}"
            );
        }
    }
}

// --- G4: header elision ------------------------------------------------------

const HEADER_SRC: &str = "app Probe\nGiven\n Task { title:text, state:enum(open,done)=open }\n policy Task read=members\n fixture one=Task { title=\"a\", state=open }\nWhen\n scenario close(task:Task,state:Task.state) by=members\n  require task.state==open\n  do set task {state=done}\n  examples seed=[one] task=one state=done\n   as,task.state -> task.state\n   members,open -> done\n   members,done -> error(rule_failed)\nThen\n";

/// A header case elides exactly like the same case in a fixture value:
/// neither position reports `E2001`.
#[test]
fn header_enum_case_elides_like_fixture() {
    let (_program, diags) = check_src(HEADER_SRC, None);
    let e2001: Vec<_> = diags.iter().filter(|d| d.code == "E2001").collect();
    assert!(e2001.is_empty(), "header case elides: {diags:?}");
}

/// Parity the other way: a non-case in a header binding still `E2001`s,
/// exactly as it does in a fixture value.
#[test]
fn header_non_case_still_e2001() {
    let src = HEADER_SRC.replace("state=done\n   as", "state=bogus\n   as");
    let (_program, diags) = check_src(&src, None);
    let (start, end) = span_of(&src, "state=bogus", 1);
    let offset = start + "state=".len() as u32;
    let hits = covering(&diags, "E2001", offset);
    assert_eq!(hits.len(), 1, "non-case header still E2001s: {diags:?}");
    assert_eq!((hits[0].primary.start, hits[0].primary.end), (offset, end));
    assert!(hits[0].message.contains("'bogus'"), "{}", hits[0].message);
}

/// CanFeedback:176 `status=planned` elides; the G1 `set`-target
/// `status=proposed` at :201 keeps its `E2001` (out of packet scope).
#[test]
fn canfeedback_176_planned_elides() {
    let Some(catalog) = real_catalog() else {
        eprintln!("SKIP canfeedback_176_planned_elides: no packages/values/dist/catalog.json");
        return;
    };
    let (db, id, text) = load_draft("CanFeedback.can");
    let (_program, diags) = check_program(&db, &[id], Some(&catalog));
    let (start, _) = span_of(
        &text,
        "examples seed=[own_vote,foreign_vote] suggestion=suggestion status=planned",
        1,
    );
    let offset =
        start + "examples seed=[own_vote,foreign_vote] suggestion=suggestion status=".len() as u32;
    let hits = covering(&diags, "E2001", offset);
    assert!(hits.is_empty(), "CanFeedback:176 planned elides: {hits:?}");
    // G1 fixed: `set decision.parent {status=proposed, ...}` now elides —
    // `proposed` is a genuine Suggestion.status case, and set-target
    // record literals get expected-type context like expression position.
    let (start, _) = span_of(&text, "moderation_reason=reason,status=proposed", 1);
    let offset = start + "moderation_reason=reason,status=".len() as u32;
    let hits = covering(&diags, "E2001", offset);
    assert!(hits.is_empty(), "G1 proposed now elides: {hits:?}");
}

/// CanInbox `urgency=routine` parity: the examples header keeps its
/// `E2001` exactly like the fixture `urgency=today` — both are
/// G3-blocked (`Triage.urgency.level` carries no expected enum until
/// judgment resolution lands), so neither position elides. The
/// invariant is parity itself: header and fixture must agree.
#[test]
fn caninbox_header_routine_parity() {
    let Some(catalog) = real_catalog() else {
        eprintln!("SKIP caninbox_header_routine_parity: no packages/values/dist/catalog.json");
        return;
    };
    let (db, id, text) = load_draft("CanInbox.can");
    let (_program, diags) = check_program(&db, &[id], Some(&catalog));
    let (start, _) = span_of(&text, "urgency=routine reason=", 1);
    let header = covering(&diags, "E2001", start + "urgency=".len() as u32);
    let (start, _) = span_of(&text, "urgency=today,", 1);
    let fixture = covering(&diags, "E2001", start + "urgency=".len() as u32);
    assert_eq!(
        header.len(),
        fixture.len(),
        "header and fixture agree (G3-blocked today): header={header:?} fixture={fixture:?}"
    );
    assert_eq!(header.len(), 1, "G3-blocked sites keep E2001");
    // P3 control: opaque `urgency={...level=routine...}` has no expected
    // enum, so its E2001 must survive.
    let (start, _) = span_of(&text, "level=routine", 1);
    let offset = start + "level=".len() as u32;
    let hits = covering(&diags, "E2001", offset);
    assert_eq!(hits.len(), 1, "opaque level=routine keeps E2001");
}

// --- Emission parity ---------------------------------------------------------

/// Minimal table: both data rows emit, the value row with `expected:`,
/// the `error()` row with `error:`; header case value emits as text.
#[test]
fn minimal_table_rows_emit_expected_and_error() {
    let catalog = fixture_catalog();
    let (program, diags) = check_src(HEADER_SRC, Some(&catalog));
    assert!(
        diags.iter().all(|d| d.code != "E2001"),
        "minimal header elides: {diags:?}"
    );
    assert_eq!(program.examples.tables.len(), 1);
    assert_eq!(program.examples.tables[0].rows, 2);
    let (artifact, emit_diags) =
        emit_test_only(&program, &program_db(HEADER_SRC), &diags, Some(&catalog));
    assert!(
        emit_diags.is_empty(),
        "minimal table emits clean: {emit_diags:?}"
    );
    let js: Vec<_> = artifact.tests.iter().map(|t| t.module.js.clone()).collect();
    let joined = js.join("\n");
    assert!(
        joined.contains("state:\"done\""),
        "header case emits as case text:\n{joined}"
    );
    let tables = emitted_tables(&joined);
    assert_eq!(tables.len(), 1, "one table emits:\n{joined}");
    assert_eq!(tables[0].len(), 2, "both rows emit:\n{joined}");
    assert_runnable(&tables);
    assert!(
        joined.contains(",error:\"rule_failed\""),
        "error row carries its code:\n{joined}"
    );
}

fn program_db(src: &str) -> SourceDb {
    let mut db = SourceDb::new();
    db.add("test.can".to_string(), src.to_string());
    db
}

/// Draft parity: every recorded table emits with every authored data row
/// runnable, and no example-scoped omission diagnostic fires.
fn assert_draft_parity(name: &str, catalog: &Catalog) {
    let (db, id, _) = load_draft(name);
    let (program, diags) = check_program(&db, &[id], Some(catalog));
    let want_tables = program.examples.tables.len();
    let want_rows: usize = program.examples.tables.iter().map(|t| t.rows).sum();
    assert!(want_tables > 0, "{name}: draft carries tables");
    assert!(want_rows > 0, "{name}: draft carries data rows");
    let table_spans: Vec<Span> = program.examples.tables.iter().map(|t| t.span).collect();
    let (artifact, emit_diags) = emit_test_only(&program, &db, &diags, Some(catalog));
    // E6006 table omissions are this packet's gap class: a dropped table
    // yields no BDD rows at all. E6008 cell-lowering gaps (decimal
    // literals, duration arithmetic, ...) are general ir/js lowering work
    // shared with non-example positions; rows still emit around them
    // with fail-closed stubs, so they are observed, not asserted, here.
    let omissions: Vec<_> = emit_diags
        .iter()
        .filter(|d| {
            d.code == "E6006"
                && table_spans.iter().any(|s| {
                    s.file == d.primary.file && s.start <= d.primary.start && d.primary.end <= s.end
                })
        })
        .collect();
    assert!(
        omissions.is_empty(),
        "{name}: no example-table omission: {omissions:?}"
    );
    let joined = artifact
        .tests
        .iter()
        .map(|t| t.module.js.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let tables = emitted_tables(&joined);
    assert_eq!(
        tables.len(),
        want_tables,
        "{name}: every table emits (want {want_tables})"
    );
    let got_rows: usize = tables.iter().map(Vec::len).sum();
    assert_eq!(
        got_rows, want_rows,
        "{name}: every data row emits (want {want_rows})"
    );
    assert_runnable(&tables);
}

#[test]
fn canfeedback_tables_row_parity() {
    let Some(catalog) = real_catalog() else {
        eprintln!("SKIP canfeedback_tables_row_parity: no packages/values/dist/catalog.json");
        return;
    };
    assert_draft_parity("CanFeedback.can", &catalog);
}

#[test]
fn caninbox_tables_row_parity() {
    let Some(catalog) = real_catalog() else {
        eprintln!("SKIP caninbox_tables_row_parity: no packages/values/dist/catalog.json");
        return;
    };
    assert_draft_parity("CanInbox.can", &catalog);
}

// --- T35/R24: payload id/version vs reserved metadata --------------------------
// Example headers may observe DECLARED payload leaves (`id`, `version`,
// ...) where the owner contract declares them; stored identity/audit
// overrides stay rejected. Every verdict keys on resolved provenance
// (the nominal + declared leaf), never on field-name spelling.

const T35R24_SRC: &str = "app Probe\nGiven\n contract Outcome { source:text, version:int, state:enum(pending,done)=pending }\n contract Intake { id:text, body:text }\n capability BoxV1 version=1\n  fetch(source:text) -> Outcome\n  event arrived { value:Intake }\n  event changed { value:Outcome }\n Doc { title:text }\n Note in Doc { body:text }\n policy Doc read=members\n policy Note read=members\n fixture one=Doc { title=\"a\" }\n fixture note=Note { parent=one, body=\"n\" }\nWhen\n scenario fetched on=BoxV1.fetch.completed\n  do let seen=1\n  examples event={delivery_id=\"d\",status=succeeded,result={source=\"s\",version=1,state=pending},error=null}\n   event.result.version -> one.title\n   1 -> \"a\"\n scenario arrived_mail on=BoxV1.arrived\n  do let seen=1\n  examples event={value={id=\"m\",body=\"b\"}}\n   event.value.id -> one.title\n   \"m\" -> \"a\"\n scenario changed_mail on=BoxV1.changed\n  do let seen=1\n  examples event={value={source=\"s\",version=2,state=done}}\n   event.value.version -> one.title\n   2 -> \"a\"\n scenario touch(doc:Doc) by=members\n  do set doc {title=\"b\"}\n  examples seed=[one] doc=one\n   as,doc.id -> doc.title\n   members,\"x\" -> \"b\"\n  examples seed=[one] doc=one\n   as,doc.version -> doc.title\n   members,3 -> \"b\"\n  examples seed=[one] doc=one\n   as,doc.created -> doc.title\n   members,\"t\" -> \"b\"\n  examples seed=[one] doc=one\n   as,doc.parent -> doc.title\n   members,one -> \"b\"\n scenario annotate(item:Note) by=members\n  do set item {body=\"c\"}\n  examples seed=[note] item=note\n   as,item.parent -> item.body\n   members,one -> \"c\"\n  examples seed=[note] item=note\n   as,item.parent.title -> item.body\n   members,\"a\" -> \"c\"\nThen\n";

/// CanPropose:254 shape: `event.result.version` is a declared leaf of
/// the completion result nominal (`Outcome.version`) — observable.
#[test]
fn t35r24_completion_result_version_observable() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "event.result.version -> one.title", 1);
    let offset = start + "event.result.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "declared result leaf observable: {diags:?}"
    );
    assert!(
        covering(&diags, "E5002", offset).is_empty(),
        "declared result leaf resolves (not silent): {diags:?}"
    );
}

/// CanDesk:139 shape: `event.value.id` is a declared leaf of the
/// event value nominal (`Intake.id`) — observable.
#[test]
fn t35r24_event_value_id_observable() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "event.value.id -> one.title", 1);
    let offset = start + "event.value.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "declared value leaf observable: {diags:?}"
    );
    assert!(
        covering(&diags, "E5002", offset).is_empty(),
        "declared value leaf resolves (not silent): {diags:?}"
    );
}

/// CanPropose:289 shape: `event.value.version` through a declared
/// event value nominal (`Outcome.version`) — observable.
#[test]
fn t35r24_event_value_version_observable() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "event.value.version -> one.title", 1);
    let offset = start + "event.value.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "declared value leaf observable: {diags:?}"
    );
    assert!(
        covering(&diags, "E5002", offset).is_empty(),
        "declared value leaf resolves (not silent): {diags:?}"
    );
}

/// Stored identity override stays rejected: `doc.id` on a stored
/// model is reserved metadata, not a payload leaf.
#[test]
fn t35r24_stored_id_rejected() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "as,doc.id -> doc.title", 1);
    let offset = start + "as,doc.".len() as u32;
    let hits = covering(&diags, "E5008", offset);
    assert_eq!(hits.len(), 1, "stored id override rejected: {diags:?}");
    assert!(
        hits[0].message.contains("reserved metadata"),
        "{}",
        hits[0].message
    );
}

/// Stored `version` override stays rejected: no declared field, only
/// the reserved spelling on a stored model.
#[test]
fn t35r24_stored_version_rejected() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "as,doc.version -> doc.title", 1);
    let offset = start + "as,doc.".len() as u32;
    let hits = covering(&diags, "E5008", offset);
    assert_eq!(hits.len(), 1, "stored version override rejected: {diags:?}");
    assert!(
        hits[0].message.contains("reserved metadata"),
        "{}",
        hits[0].message
    );
}

/// Stored audit override stays rejected: `doc.created` is audit
/// metadata on a stored model.
#[test]
fn t35r24_stored_created_rejected() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "as,doc.created -> doc.title", 1);
    let offset = start + "as,doc.".len() as u32;
    let hits = covering(&diags, "E5008", offset);
    assert_eq!(hits.len(), 1, "stored audit override rejected: {diags:?}");
    assert!(
        hits[0].message.contains("reserved metadata"),
        "{}",
        hits[0].message
    );
}

/// CanReport:110 shape (bucket-a retention): `item.parent` at the
/// leaf of a contained model overrides stored containment identity.
#[test]
fn t35r24_contained_parent_rejected() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "as,item.parent -> item.body", 1);
    let offset = start + "as,item.".len() as u32;
    let hits = covering(&diags, "E5008", offset);
    assert_eq!(
        hits.len(),
        1,
        "contained parent override rejected: {diags:?}"
    );
    assert!(
        hits[0].message.contains("server-owned"),
        "{}",
        hits[0].message
    );
}

/// Control: `parent` mid-path still navigates into the containing
/// record — only the leaf override is server-owned.
#[test]
fn t35r24_parent_midpath_navigates() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "as,item.parent.title -> item.body", 1);
    let offset = start + "as,item.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "parent mid-path navigates: {diags:?}"
    );
    assert!(
        covering(&diags, "E5002", offset).is_empty(),
        "parent mid-path resolves: {diags:?}"
    );
}

/// Same spelling, different provenance, different verdicts: `id` and
/// `version` are observable as declared payload leaves but rejected
/// as stored-model overrides.
#[test]
fn t35r24_provenance_key_payload_vs_stored() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    for (header, prefix) in [
        ("event.value.id -> one.title", "event.value."),
        ("event.result.version -> one.title", "event.result."),
        ("event.value.version -> one.title", "event.value."),
    ] {
        let (start, _) = span_of(T35R24_SRC, header, 1);
        let offset = start + prefix.len() as u32;
        assert!(
            covering(&diags, "E5008", offset).is_empty(),
            "payload {header} observable: {diags:?}"
        );
    }
    for (header, prefix) in [
        ("as,doc.id -> doc.title", "as,doc."),
        ("as,doc.version -> doc.title", "as,doc."),
    ] {
        let (start, _) = span_of(T35R24_SRC, header, 1);
        let offset = start + prefix.len() as u32;
        assert_eq!(
            covering(&diags, "E5008", offset).len(),
            1,
            "stored {header} rejected: {diags:?}"
        );
    }
}

/// Same spelling, different provenance, different verdicts: `parent`
/// on a contained model is server-owned (`E5008`); on a
/// non-contained model it names no member at all (`E5002`).
#[test]
fn t35r24_provenance_key_parent() {
    let (_program, diags) = check_src(T35R24_SRC, None);
    let (start, _) = span_of(T35R24_SRC, "as,item.parent -> item.body", 1);
    let offset = start + "as,item.".len() as u32;
    assert_eq!(
        covering(&diags, "E5008", offset).len(),
        1,
        "contained parent is E5008: {diags:?}"
    );
    let (start, _) = span_of(T35R24_SRC, "as,doc.parent -> doc.title", 1);
    let offset = start + "as,doc.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "non-contained parent is not E5008: {diags:?}"
    );
    let hits = covering(&diags, "E5002", offset);
    assert_eq!(hits.len(), 1, "non-contained parent is E5002: {diags:?}");
    assert!(
        hits[0].message.contains("unknown field"),
        "{}",
        hits[0].message
    );
}

/// Draft pin: CanDesk:139 `event.value.id` observes the declared
/// `IncomingMail.id` payload leaf (same-file owner, resolves
/// single-file too).
#[test]
fn t35r24_desk139_value_id_observable() {
    let Some(catalog) = real_catalog() else {
        eprintln!("SKIP t35r24_desk139_value_id_observable: no packages/values/dist/catalog.json");
        return;
    };
    let (db, id, text) = load_draft("CanDesk.can");
    let (_program, diags) = check_program(&db, &[id], Some(&catalog));
    let (start, _) = span_of(&text, "event.value.id -> count(Unmatched)", 1);
    let offset = start + "event.value.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "CanDesk:139 payload id observable: {diags:?}"
    );
    assert!(
        covering(&diags, "E5002", offset).is_empty(),
        "CanDesk:139 payload id resolves: {diags:?}"
    );
}

/// Draft pins: CanPropose:254 `event.result.version` and :289
/// `event.value.version` observe the declared
/// `ReservationOfferOutcome.version` payload leaf. The owner lives
/// in CanRent, so the pair must check together (whole-corpus mode).
#[test]
fn t35r24_propose_result_and_value_version_observable() {
    let Some(catalog) = real_catalog() else {
        eprintln!(
            "SKIP t35r24_propose_result_and_value_version_observable: no packages/values/dist/catalog.json"
        );
        return;
    };
    let root = workspace_root();
    let propose = std::fs::read_to_string(root.join("draft/CanPropose.can")).expect("propose");
    let rent = std::fs::read_to_string(root.join("draft/CanRent.can")).expect("rent");
    let mut db = SourceDb::new();
    let propose_id = db.add("draft/CanPropose.can".to_string(), propose.clone());
    let rent_id = db.add("draft/CanRent.can".to_string(), rent);
    let (_program, diags) = check_program(&db, &[propose_id, rent_id], Some(&catalog));
    let (start, _) = span_of(
        &propose,
        "current_offer.booking_version,event.result.version -> current_offer.handoff",
        1,
    );
    let offset = start + "current_offer.booking_version,event.result.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "CanPropose:254 payload version observable: {diags:?}"
    );
    assert!(
        covering(&diags, "E5002", offset).is_empty(),
        "CanPropose:254 payload version resolves: {diags:?}"
    );
    let (start, _) = span_of(
        &propose,
        "event.value.kind,event.value.version,current_offer.booking_version ->",
        1,
    );
    let offset = start + "event.value.kind,event.value.".len() as u32;
    assert!(
        covering(&diags, "E5008", offset).is_empty(),
        "CanPropose:289 payload version observable: {diags:?}"
    );
    assert!(
        covering(&diags, "E5002", offset).is_empty(),
        "CanPropose:289 payload version resolves: {diags:?}"
    );
}

/// Draft pin (bucket-a resolution): T36 replaced the CanReport:110/:113
/// `run.parent` per-row overrides with the `service_run` fixture
/// (parent=service_backlog), so the rescoped tables carry no `E5008`.
/// (Was `t35r24_report_parent_stays_rejected`; the R24 rule itself
/// stays pinned inline by `t35r24_contained_parent_rejected`.)
#[test]
fn t36_report_parent_override_resolved() {
    let Some(catalog) = real_catalog() else {
        eprintln!("SKIP t36_report_parent_override_resolved: no packages/values/dist/catalog.json");
        return;
    };
    let (db, id, text) = load_draft("CanReport.can");
    let (_program, diags) = check_program(&db, &[id], Some(&catalog));
    for header in [
        "as,run.state -> result.quantity,result.state,result.complete",
        "as,run.state,run.checkpoint.complete,run.rows -> result.quantity,result.amount,result.state,result.complete",
    ] {
        let _ = span_of(&text, header, 1);
    }
    let hits: Vec<_> = diags.iter().filter(|d| d.code == "E5008").collect();
    assert!(
        hits.is_empty(),
        "resolved CanReport.can has no E5008: {hits:?}"
    );
}

/// T02 pilot B1: a `Cap.op.completed` handler body sees the DESIGN §8
/// delivery envelope — `event.status` claims the closed outcome
/// vocabulary and `event.result` carries the op's declared result
/// (narrowed non-null past `!=null`), so result members resolve.
#[test]
fn t02_completion_body_sees_typed_envelope() {
    const SRC: &str = "app Probe\nGiven\n contract Outcome { source:text, state:enum(pending,done)=pending }\n capability BoxV1 version=1\n  fetch(source:text) -> Outcome\nWhen\n scenario fetched on=BoxV1.fetch.completed\n  do\n   if event.status==succeeded and event.result!=null\n    let got=event.result\n    require got.state==done\nThen\n";
    let (_program, diags) = check_src(SRC, None);
    assert!(
        diags.is_empty(),
        "completion handler body is clean: {diags:?}"
    );
}

/// T02 pilot B2 (intended-rejection witness): a top-level
/// `preferences` invariant passes the Nullable-by-design `actor`
/// to a `user` parameter, so `E3001` still fires. The guarded
/// opposing case stays clean.
#[test]
fn t02_preferences_invariant_nullable_actor_rejected() {
    const SRC: &str = "app Probe\nGiven\n derive needs(person:user):bool = true\n preferences { view:enum(all,today)=all }\n invariant preferences: needs(actor)\nWhen\nThen\n";
    let (_program, diags) = check_src(SRC, None);
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// T02 pilot B2 opposing case: null-guarded `actor` narrows, so
/// the same invariant is clean.
#[test]
fn t02_preferences_invariant_guarded_actor_accepted() {
    const SRC: &str = "app Probe\nGiven\n derive needs(person:user):bool = true\n preferences { view:enum(all,today)=all }\n invariant preferences: actor==null or needs(actor)\nWhen\nThen\n";
    let (_program, diags) = check_src(SRC, None);
    assert!(
        diags.is_empty(),
        "guarded preferences invariant is clean: {diags:?}"
    );
}

/// T02 pilot B3 (intended-rejection witness): a derive calling
/// the catalog `state-read` builtin `active_member` still fails
/// `E3010` derive purity (DESIGN:137; catalog notes "Needs
/// membership state"). Skips without the real catalog.
#[test]
fn t02_derive_state_read_builtin_rejected() {
    let Some(catalog) = real_catalog() else {
        eprintln!(
            "SKIP t02_derive_state_read_builtin_rejected: no packages/values/dist/catalog.json"
        );
        return;
    };
    const SRC: &str = "app Probe\nGiven\n derive staff(person:user):bool = active_member(person,team)\nWhen\nThen\n";
    let (_program, diags) = check_src(SRC, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
}

/// T02 pilot B3 opposing case: a pure derive with no effectful
/// call stays clean under the same catalog.
#[test]
fn t02_derive_pure_accepted() {
    let Some(catalog) = real_catalog() else {
        eprintln!("SKIP t02_derive_pure_accepted: no packages/values/dist/catalog.json");
        return;
    };
    const SRC: &str = "app Probe\nGiven\n derive staff(person:user):bool = true\nWhen\nThen\n";
    let (_program, diags) = check_src(SRC, Some(&catalog));
    assert!(diags.is_empty(), "pure derive is clean: {diags:?}");
}
