//! B4 F3 tests: check-pass fixes for local-event payloads, auth
//! narrowing, empty-array unification, message descriptors, derived
//! inputs, delivery-leaf selectors, timeline rows and opaque receipts.
//!
//! Each test pins post-fix behavior through the full `check_program`
//! pipeline: sources that must check clean do, and the new `E3019`
//! fires exactly on silently-opaque capability receipts. The inline
//! catalog carries only the `format` overloads (transcribed from the
//! real producer catalog).

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::explain;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Catalog with the real `format` overloads plus `count` (collection
/// positions in UI/policy tests stay builtin-clean).
const FIXTURE_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-b4",
  "entries": [
    {"id": "count", "js": "count", "owner": "test", "kind": "builtin", "signature": "count(domain:C<T>)->int", "effects": "pure", "availability": "implemented"},
    {"id": "format", "js": "format", "owner": "test", "kind": "builtin", "signature": "format(template:text,values:closed object of Display)->text; format(descriptor:message,locale:locale?)->text", "effects": "pure", "availability": "implemented"}
  ]
}"#;

fn fixture() -> Catalog {
    let dir = std::env::temp_dir().join(format!(
        "can-b4-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("catalog.json");
    std::fs::write(&path, FIXTURE_JSON).unwrap();
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

/// Check one source through the full pipeline, sorted by span+code.
fn check(src: &str, catalog: Option<&Catalog>) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (_program, mut diags) = check_program(&db, &[id], catalog);
    diags.sort_by(|a, b| {
        (a.primary.start, a.primary.end, &a.code).cmp(&(b.primary.start, b.primary.end, &b.code))
    });
    diags
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

/// (1) Local-event payloads carry declared types: `event.item.s`
/// claims the bare enum case instead of erroring `E2001`.
#[test]
fn local_event_payload_typed() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { s:enum(a,b)=a }\n policy M read=members\n event Due { item:M, n:int }\nWhen\n scenario h on=Due\n  require event.item.s==a and event.n==1\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "typed event payload: {diags:?}");
}

/// (1) Unknown members on a validated local event are `E2013` (the
/// payload is a typed record, not `{opaque}`).
#[test]
fn local_event_unknown_member_errors() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { s:enum(a,b)=a }\n policy M read=members\n event Due { item:M }\nWhen\n scenario h on=Due\n  require event.zzz==1\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (2) `by=<role>` narrows `actor` exactly like `by=authenticated`.
#[test]
fn auth_narrowing_by_role() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=r\n  require actor.email_verified\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "by=role narrows actor: {diags:?}");
}

/// (2) Policy `read=<role>` narrows `actor` in `where=`.
#[test]
fn auth_narrowing_policy_where() {
    let catalog = fixture();
    let src = "app T\nGiven\n role staff\n M { t:text }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=staff where=ok(actor)\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "policy read= narrows actor: {diags:?}");
}

/// (2) `by=public` still leaves `actor` nullable.
#[test]
fn auth_no_narrowing_by_public() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=public\n  require actor.email_verified\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (3) Empty arrays unify against an explicit expected array type.
#[test]
fn empty_array_unifies() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { fs:file[]=[] }\n policy M read=members\nWhen\n scenario s(fs:file[]=[]) by=members\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "file[]=[] unifies: {diags:?}");
}

/// (4) `format("…"@{…},locale=null)` takes the message overload.
#[test]
fn format_descriptor_with_null_locale() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  do\n   let t = format(\"Hi\"@{nl=\"Hoi\"},locale=null)\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "descriptor format call: {diags:?}");
}

/// (5) Healthy derived fields are not creation/fixture inputs.
#[test]
fn derived_field_not_required() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { due:datetime, state:enum(a,b)=a }\n derive M.over:bool = row.state==a\n policy M read=members\n fixture f=M {due=now}\nWhen\n scenario s(d:datetime) by=members\n  do\n   create M {due=d} as m\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "derived field not demanded: {diags:?}");
}

/// (6) Delivery leaves are accepted in policy `fields=` exactly where
/// the same member chains resolve.
#[test]
fn delivery_leaf_in_policy_fields() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use zzz {Mail} from=deployment.mail\n Given\n  M { delivery:delivery(Mail.send)? }\n  policy M read=members fields=delivery.status\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "delivery.status in fields=: {diags:?}");
}

/// (6) Delivery leaves are accepted in UI `columns=`.
#[test]
fn delivery_leaf_in_ui_columns() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use zzz {Mail} from=deployment.mail\n Given\n  M { delivery:delivery(Mail.send)? }\n  policy M read=members\n When\n Then\n  page /t title=\"T\"\n   table M columns=delivery.status\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "delivery.status in columns=: {diags:?}");
}

/// (6) Descent past a delivery leaf still fails: leaves are terminal.
#[test]
fn delivery_leaf_descent_past_leaf_errors() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use zzz {Mail} from=deployment.mail\n Given\n  M { delivery:delivery(Mail.send)? }\n  policy M read=members fields=delivery.status.code\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (7) Timeline `slot item` binds `row` to the timeline domain.
#[test]
fn timeline_slot_binds_row() {
    let catalog = fixture();
    let src = "app T\nGiven\n Meeting { title:text }\n Amendment { text:text }\n policy Meeting read=members\n policy Amendment read=members\nWhen\nThen\n page /t title=\"T\"\n  list Meeting\n   timeline Amendment\n    slot item\n     text row.text\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "timeline row is Amendment: {diags:?}");
}

/// (8) A delivery recipe for a deployment-bound capability is `E3019`.
#[test]
fn opaque_receipt_fixture() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use zzz {Mail} from=deployment.mail\n Given\n  fixture attempt=Mail.send {request={to=\"a@b.test\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3019"], "{diags:?}");
}

/// (8) A `send` to a deployment-bound capability is `E3019`.
#[test]
fn opaque_receipt_send() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use zzz {Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3019"], "{diags:?}");
}

/// (8) Recipes for locally-declared capabilities stay `E3019`-free.
#[test]
fn local_capability_receipt_clean() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Ack { ok:bool }\n capability Mail version=1\n  notify(to:text) -> Ack\nWhen\n scenario s() by=members\n  do\n   send Mail.notify {to=\"a@b.test\"} as attempt\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "local capability send: {diags:?}");
}

/// (8) The `E3019` explain entry round-trips: invalid emits it, valid
/// checks clean.
#[test]
fn explain_e3019_round_trip() {
    let catalog = fixture();
    let info = explain::lookup("E3019").expect("E3019 entry");
    let diags = check(info.example_invalid, Some(&catalog));
    assert!(codes(&diags).contains(&"E3019"), "E3019 invalid: {diags:?}");
    let valid = check(info.example_valid, Some(&catalog));
    assert!(valid.is_empty(), "E3019 valid: {valid:?}");
}
