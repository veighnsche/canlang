//! B4 F3 tests: check-pass fixes for local-event payloads, auth
//! narrowing, empty-array unification, message descriptors, derived
//! inputs, delivery-leaf selectors, timeline rows and opaque receipts.
//!
//! Each test pins post-fix behavior through the full `check_program`
//! pipeline: sources that must check clean do, and the new `E3019`
//! fires exactly on silently-opaque capability receipts. The inline
//! catalog carries only the `format` overloads (transcribed from the
//! real producer catalog).

use canlang_compiler::analysis::CheckedProgram;
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::effects::CheckedDescription;
use canlang_compiler::analysis::resolve::{ModelOwner, SymbolKind};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::explain;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::syntax::SyntaxKind;
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
    fixture_with(FIXTURE_JSON)
}

/// Catalog with a state-reading builtin (T06 layer-2 stay: bounded
/// reads remain gated until the T32 read contract is adopted).
const READ_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-b4-read",
  "entries": [
    {"id": "needy", "js": "needy", "owner": "test", "kind": "builtin", "signature": "needy(person:user)->bool", "effects": "state-read", "availability": "implemented"}
  ]
}"#;

fn fixture_with(json: &str) -> Catalog {
    let dir = std::env::temp_dir().join(format!(
        "can-b4-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
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

// --- T08 selector unification: canonical parent/metadata/value leaves ---
//
// Policy/UI selectors navigate the same roots expression member
// lookup accepts (contained-model `parent`, readable metadata,
// singular value leaves); unknown leaves, reference interiors,
// terminal descent, disclosure and metadata writes keep failing.

/// (T08) Policy `fields=` accepts `parent`, readable metadata and
/// money leaves on a contained model (CanApprove:18 shape).
#[test]
fn t08_parent_metadata_value_in_policy_fields() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { t:text }\n C in P { kind:enum(a,b)=a, total:money }\n policy C read=members fields=parent,kind,total.currency,created_by,created,updated_by,updated,archived_at,id,version\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "policy parent/metadata/value: {diags:?}");
}

/// (T08) UI `columns=`/`filter=` agree with policy on `parent`,
/// metadata and money leaves (CanAffiliate:253 shape).
#[test]
fn t08_parent_metadata_value_in_ui() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { t:text }\n Sale in P { amount:money, reversed:bool=false }\n policy Sale read=members\nWhen\nThen\n page /t title=\"T\"\n  table Sale columns=parent,amount,reversed,created filter=reversed,amount.currency\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "ui parent/metadata/value: {diags:?}");
}

/// (T08) Nullable intermediates unwrap before the value leaf.
#[test]
fn t08_nullable_money_intermediate() {
    let catalog = fixture();
    let src =
        "app T\nGiven\n M { tip:money? }\n policy M read=members fields=tip.currency\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nullable money leaf: {diags:?}");
}

/// (T08) Stable `user.id` reads through a user-typed field.
/// (T25-L1) Leaf grants never traverse references (DESIGN §4, normative
/// since 0f01d13; T08 acceptance covers parent/metadata/money only): the
/// `owner.id` GRANT is `E4012`. Expression reads of `owner.id` stay
/// legal (the path resolves — `E2013` never fires beside `E4012`).
#[test]
fn t08_user_id_member() {
    let catalog = fixture();
    let src =
        "app T\nGiven\n M { owner:user }\n policy M read=members fields=owner.id\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E4012"], "user.id grant: {diags:?}");
}

/// (T08) `parent` is selectable in `lock fields=` (CanKnowledge:63).
#[test]
fn t08_parent_in_lock_fields() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { t:text }\n C in P { n:int }\n policy C read=members\n lock C fields=parent,n\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "lock parent: {diags:?}");
}

/// (T08) Opaque (deployment-bound, schema-unavailable) interiors
/// defer silently in selectors exactly as in expressions
/// (CanChat:28 `request.progress.*` shape).
#[test]
fn t08_opaque_interior_defers() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use zzz {Box} from=deployment.mail\n Given\n  M { request:delivery(Box.send)? }\n  policy M read=members fields=request.progress.state\n When\n Then\n  page /t title=\"T\"\n   table M columns=request.progress.state\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "opaque interior defers: {diags:?}");
}

/// (T08) A poisoned field base stays silent in selectors (cascade
/// suppression): only the declaration `E2001` fires, no `E2013`.
#[test]
fn t08_error_base_suppresses_selector_cascade() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { envelope:Missing, queue:text }\n policy M read=members fields=envelope.received,queue\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2001"], "{diags:?}");
}

/// (T08) Delivery leaves resolve through import aliases
/// (`use zzz {EmailV1 as Mail} from=...`).
#[test]
fn t08_import_alias_delivery_leaf() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use zzz {EmailV1 as Mail} from=deployment.mail\n Given\n  M { delivery:delivery(Mail.send)? }\n  policy M read=members fields=delivery.status\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "aliased delivery leaf: {diags:?}");
}

/// (T08) Unknown leaves still fail.
#[test]
fn t08_unknown_leaf_still_e2013() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text }\n policy M read=members fields=bogus_leaf_xyz\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T08) `parent` on a non-contained model still fails.
#[test]
fn t08_parent_without_containment_still_e2013() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text }\n policy M read=members fields=parent\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T08) Model-reference interiors still fail (CanEnrich:205
/// `lookup.provider` shape): traversal grants nothing.
#[test]
fn t08_reference_interior_still_e2013() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { provider:text }\n M { lookup:P }\n policy M read=members fields=lookup.provider\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T08) `parent` is terminal: descent into another record's fields
/// still fails.
#[test]
fn t08_parent_interior_still_e2013() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { t:text }\n C in P { n:int }\n policy C read=members fields=parent.t\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T08) Descent past a scalar value leaf still fails.
#[test]
fn t08_scalar_leaf_descent_still_e2013() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { amount:money }\n policy M read=members fields=amount.currency.code\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T08) Account contact stays disclosure-gated: `owner.email`
/// fails where `owner.id` reads.
#[test]
fn t08_user_email_disclosure_still_e2013() {
    let catalog = fixture();
    let src =
        "app T\nGiven\n M { owner:user }\n policy M read=members fields=owner.email\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T08) Reserved metadata stays rejected as a CRUD input (write
/// context keeps the contract-only rule).
#[test]
fn t08_crud_metadata_input_still_e2013() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text }\n policy M read=members\nWhen\n crud M by=members fields=title,created\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T08) Reserved metadata stays unsettable.
#[test]
fn t08_metadata_write_still_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  do\n   set m {created=now}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T08) A selector grant supplies no narrowing fact: the nullable
/// field still needs its guard at use sites.
#[test]
fn t08_selector_grants_no_fact() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { nick:text?, nick2:text }\n policy M read=members fields=nick\nWhen\n scenario s(m:M) by=members\n  do\n   set m {nick2=m.nick}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (A5/S1) Bare `id`/`version` are terminal readable roots in UI
/// selectors too (CanEvent:41 grants them in policy `fields=`).
#[test]
fn a5_s1_ui_columns_accept_id_version() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text }\n policy M read=members\nWhen\nThen\n page /t title=\"T\"\n  table M columns=id,version,title,created\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "ui id/version roots: {diags:?}");
}

/// (A5/S1) `id`/`version` admit no descent in policy or UI contexts.
#[test]
fn a5_s1_id_version_descent_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text }\n policy M read=members fields=id.tag\nWhen\nThen\n page /t title=\"T\"\n  table M columns=version.n\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013", "E2013"], "{diags:?}");
}

/// (A5/S4) Reference interiors are `E4012` in UI `columns=` exactly
/// as in policy `fields=`: declared `user` chain.
#[test]
fn a5_s4_ui_columns_reference_interior_e4012() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { owner:user, title:text }\n policy M read=members\nWhen\nThen\n page /t title=\"T\"\n  table M columns=owner.id,title\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E4012"], "{diags:?}");
}

/// (A5/S4) Reserved-root reference interiors are `E4012` in UI
/// `filter=` too (`created_by.id` resolves, then the grant fails).
#[test]
fn a5_s4_ui_filter_reserved_reference_e4012() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text }\n policy M read=members\nWhen\nThen\n page /t title=\"T\"\n  table M columns=title filter=created_by.id\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E4012"], "{diags:?}");
}

/// (T05) Affiliate if/else (R01): the `else` of `p==null` proves
/// `p` non-null for member reads and the `set` target; the
/// then-branch create does not disturb the join.
#[test]
fn t05_affiliate_if_else() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B?, box:text? }\n policy B read=members\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let p = m\n   if p==null\n    create M {box=\"e\"} as e\n   else\n    let t = p.box\n    set p {box=\"f\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "affiliate if/else: {diags:?}");
}

/// (T05) Approve AND-continuation (R02): the right conjunct and the
/// body receive left-true facts; the `send ... when=` OR re-reads
/// the guarded row pre-dispatch; the trailing `set` keeps the root
/// fact across the send.
#[test]
fn t05_approve_and_send_when() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B?, box:text? }\n policy B read=members\n policy M read=members\n contract Ack { ok:bool }\n capability Mail version=1\n  notify(who:text) -> Ack\nWhen\n scenario s(m:M?) by=members\n  do\n   let notice = m\n   if notice!=null and notice.box==null\n    send Mail.notify {who=\"x\"} when=notice.b==null or notice.b.label==\"y\" as attempt\n    set notice {box=\"z\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "approve and/send/when: {diags:?}");
}

/// (T05) Catch OR-chain in a leading require (R05): each disjunct
/// receives the accumulated left-false facts, twice in one chain.
#[test]
fn t05_catch_or_chain_require() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  require m==null or m.b==null or m.b.label==\"ok\"\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "catch or-chain: {diags:?}");
}

/// (T05) Chat require-chain (R03): AND facts flow from the `require`
/// into counter reads; member-path facts hold until the `create`;
/// the root fact survives `create`/`set` into the `send ... when=`.
#[test]
fn t05_chat_require_chain() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B?, box:text? }\n policy B read=members\n policy M read=members\n contract Ack { ok:bool }\n capability Log version=1\n  ping(who:text) -> Ack\nWhen\n scenario s(m:M?) by=members\n  do\n   let a = m\n   require a!=null and a.b!=null\n   let label = a.b.label\n   create M {box=\"c\"} as c\n   set a {box=\"b\"}\n   send Log.ping {who=\"x\"} when=a.box==\"z\" as r\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "chat require-chain: {diags:?}");
}

/// (T05) Check require-continuation (R04): reads, `parent=` creation
/// and `set` all consume the `require` root fact.
#[test]
fn t05_check_require_lookup() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n Child in M { note:text? }\n policy M read=members\n policy Child read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let c = m\n   require c!=null\n   let t = c.box\n   create Child {parent=c,note=\"n\"} as ch\n   set c {box=\"d\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "check require-lookup: {diags:?}");
}

/// (T05) Contract invariant continuation (R06): OR-right facts apply
/// in invariant position.
#[test]
fn t05_contract_invariant_or() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B? }\n policy B read=members\n policy M read=members\n invariant M: row.b==null or row.b.label==\"ok\"\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "contract invariant or: {diags:?}");
}

/// (T05) Supporting shapes: reversed operands, parentheses, `not`
/// and double negation all key on the resolved tested path.
#[test]
fn t05_reversed_parens_not() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let a = m\n   require null != a\n   let t = a.box\n   let b = m\n   require (b != null)\n   let u = b.box\n   let c = m\n   require not (c == null)\n   let w = c.box\n   let d = m\n   require not (not (d != null))\n   let v = d.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "reversed/parens/not: {diags:?}");
}

/// (T05) Nested distribution: `a and (b or c)` threads the outer
/// AND-left facts into the disjunction, whose right arm additionally
/// receives the inner OR-left facts.
#[test]
fn t05_nested_and_or() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let a = m\n   require a!=null and (a.b==null or a.b.label==\"y\")\n   let t = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nested and/or: {diags:?}");
}

/// (T05 §6) Shorthand entries read their binding, so they consume
/// continuation facts exactly like explicit reads (Chat:78
/// `allowance` / Check:81 `check` shapes).
#[test]
fn t05_shorthand_reads_fact() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n N { buddy:M }\n policy M read=members\n policy N read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let buddy = m\n   require buddy!=null\n   create N {buddy} as n\n   let o = {buddy}\n   create N {buddy=o.buddy} as n2\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "shorthand reads fact: {diags:?}");
}

/// (T05 IC1) Unguarded member access still fails.
#[test]
fn t05_ic1_unguarded_member() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let t = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC1) Unguarded nullable argument still fails (C4 cascade).
#[test]
fn t05_ic1_nullable_arg() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n N { req:text }\n policy M read=members\n policy N read=members\nWhen\n scenario s(m:M) by=members\n  do\n   create N {req=m.box} as n\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T05 IC2) A use textually before its guard still fails.
#[test]
fn t05_ic2_read_before_guard() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let t = m.box\n   require m!=null\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC2) A use in an earlier conjunct still fails.
#[test]
fn t05_ic2_earlier_conjunct() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   require m.box==\"x\" and m!=null\n   let t = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC3) An OR arm whose incoming fact is `p==null` still fails.
#[test]
fn t05_ic3_or_null_arm() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   require m!=null or m.box==\"x\"\n   let t = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC3) A null admitted by another OR arm grants nothing to
/// sibling arms.
#[test]
fn t05_ic3_or_sibling_no_leak() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?, ok:bool) by=members\n  do\n   require (m!=null and ok) or m.box==\"y\"\n   let t = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC4) A member-path fact drops after a `set` through the same
/// root (proven-or-possible alias write).
#[test]
fn t05_ic4_set_invalidates_path() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B?, box:text? }\n policy B read=members\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  do\n   require m.b!=null\n   set m {box=\"s\"}\n   let l = m.b.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC4) A member-path fact drops after a mutation-capable
/// `send`, while root facts survive it.
#[test]
fn t05_ic4_send_invalidates_path() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B?, box:text? }\n policy B read=members\n policy M read=members\n contract Ack { ok:bool }\n capability Mail version=1\n  notify(who:text) -> Ack\nWhen\n scenario s(m:M) by=members\n  do\n   require m.b!=null\n   send Mail.notify {who=\"x\"} as attempt\n   let l = m.b.label\n   let t = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC5) Contradictory branches: the arm without the fact still
/// fails.
#[test]
fn t05_ic5_contradictory_branches() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?, flag:bool) by=members\n  do\n   if flag\n    require m!=null\n    let t = m.box\n   else\n    let u = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC5) Post-join uses fail unless every arm established the fact.
#[test]
fn t05_ic5_post_join_no_fact() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?, flag:bool) by=members\n  do\n   if flag\n    require m!=null\n    let t = m.box\n   else\n    let u = 1\n   let w = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC6) Facts established inside a `for` body are unavailable
/// after the loop (the in-body use passes).
#[test]
fn t05_ic6_body_fact_no_escape() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  do\n   for x in M limit=10\n    require m.b!=null\n    let l = m.b.label\n   let w = m.b.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC6) A nullable `for` domain stays nullable without a guard
/// (R28 shape for loops; the query shape moves CanInvoice:742).
#[test]
fn t05_ic6_nullable_domain() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { items:B[]? }\n policy B read=members\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  do\n   for x in m.items limit=10\n    let y = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T05 IC7) A `?.`-chain null test grants no fact about its receiver.
#[test]
fn t05_ic7_safe_access_null_test() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   require m?.box!=null\n   let t = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC7) A `?.`-chain `==null` test grants nothing either.
#[test]
fn t05_ic7_safe_access_eq_null() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   require m?.box==null\n   let t = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC7) A `?.`-chain comparison against a nullable value
/// grants nothing (the retained L171 rule only fires against
/// proven-nonnull values).
#[test]
fn t05_ic7_safe_access_eq_value() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?, o:M) by=members\n  do\n   require m?.box==o.box\n   let t = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 IC8) Facts never cross evaluations: a guard in one scenario
/// grants nothing to another (revision/currency fencing stays T32).
#[test]
fn t05_ic8_cross_scenario_no_leak() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario a(m:M?) by=members\n  require m!=null\n  do\n   let t = m.box\n scenario b(m:M?) by=members\n  do\n   let u = m.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 §9) A fact on one path grants nothing to a sibling path.
#[test]
fn t05_presence_sibling_no_leak() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { b:B?, c:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  do\n   require m.b!=null\n   let l = m.c.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 §9) A null test on another subject never narrows the caller
/// (actor admission stays T06).
#[test]
fn t05_presence_other_subject_no_actor() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=public\n  require m!=null\n  do\n   let t = m.box\n   require actor.email_verified\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 §6) Facts key on declarations: two `let` aliases of one
/// source never share.
#[test]
fn t05_decl_alias_separation() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let a = m\n   let b = m\n   require a!=null\n   let t = b.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T05 §6) Shadowing never shares: an inner `let` reusing the outer
/// spelling reads its own declaration, and the outer fact still
/// holds after the loop.
#[test]
fn t05_decl_shadow_separation() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { box:text? }\n policy M read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let a = m\n   require a!=null\n   for x in M limit=10\n    let a = m\n    let t = a.box\n   let u = a.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T08) Typed delivery leaves keep their B4 scope: `delivery.status`
/// reads in policy `fields=` but not in UI `filter=`.
#[test]
fn t08_typed_delivery_leaf_scope_preserved() {
    let catalog = fixture();
    let src = "package p\n use p {Mail as Box} from=deployment.mail\n Given\n  export capability Mail version=1\n   send(to:text) -> Ack\n  contract Ack { ok:bool }\n  M { delivery:delivery(Box.send)?, state:text }\n  policy M read=members fields=delivery.status\n When\n Then\n  page /t title=\"T\"\n   table M columns=state filter=delivery.status\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T09) Ordinary arrays omit to `[]`: a fixture may omit `tags:text[]`
/// (R09: `reviewer_worker=Employee {...}` omitting `skills:text[]`).
#[test]
fn t09_ordinary_array_fixture_omission_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text, tags:text[] }\n policy M read=members\n fixture f=M {title=\"x\"}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "ordinary array omission: {diags:?}");
}

/// (T09) Required arrays still require input: omitting `ids:text[]!`
/// from a fixture is `E3015` naming only the required field.
#[test]
fn t09_required_array_fixture_omission_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text, tags:text[], ids:text[]! }\n policy M read=members\n fixture f=M {title=\"x\"}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0].message.contains("'ids'"),
        "names the required array: {}",
        diags[0].message
    );
}

/// (T09) Genuinely-required scalars still require input: omitting
/// `title:text` from a fixture is `E3015` even when an ordinary array
/// is supplied.
#[test]
fn t09_required_scalar_fixture_omission_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text, tags:text[] }\n policy M read=members\n fixture f=M {tags=[\"a\"]}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0].message.contains("'title'"),
        "names the required scalar: {}",
        diags[0].message
    );
}

/// (T09) Ordinary arrays omit in `create` too (the `E3001` path shares
/// the same required-input rule).
#[test]
fn t09_ordinary_array_create_omission_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text, tags:text[] }\n policy M read=members\nWhen\n scenario s(t:text) by=members\n  do\n   create M {title=t} as m\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "ordinary array create omission: {diags:?}");
}

/// (T09) Required arrays still require input in `create`: omitting
/// `ids:text[]!` is `E3001`.
#[test]
fn t09_required_array_create_omission_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { title:text, tags:text[], ids:text[]! }\n policy M read=members\nWhen\n scenario s(t:text) by=members\n  do\n   create M {title=t} as m\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("'ids'"),
        "names the required array: {}",
        diags[0].message
    );
}

/// (T06) An admitting `and` conjunct carries caller admission to its
/// right sibling: `read=r and ok(actor)` checks (CanCatch shape).
#[test]
fn t06_composite_policy_and_admits() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=r and ok(actor)\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "composite read= admits: {diags:?}");
}

/// (T06) An `or` of admitting predicates admits `where=`: either arm
/// proves an authenticated caller (CanBoard/Customer shape).
#[test]
fn t06_composite_policy_or_admits_where() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n role s\n M { t:text }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=r or s where=ok(actor)\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "or-of-roles admits where=: {diags:?}");
}

/// (T06) Nested composites admit: each `and` arm proves admission,
/// so the `or` of arms admits `where=` (CanApprove shape).
#[test]
fn t06_composite_policy_nested_admits_where() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { owner:user }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=(members and row.owner==actor) or (r and row.owner==actor) where=ok(actor)\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nested composite admits: {diags:?}");
}

/// (T06) CRUD `by=` admission carries into `when=`: the guard runs
/// only for admitted callers (CanDo/CanTrade shape).
#[test]
fn t06_crud_by_to_when_admits() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=members\nWhen\n crud M by=r fields=t when=ok(actor)\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "CRUD by-to-when admits: {diags:?}");
}

/// (T06) An admitting guard conjunct admits the rest of the chain:
/// `require authenticated and ok(actor)` checks (Customer shape).
#[test]
fn t06_require_chain_admits() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=members\nWhen\n scenario s() by=public\n  require authenticated and ok(actor)\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "require chain admits: {diags:?}");
}

/// (T06) A successful admitting `require` carries admission forward:
/// `actor` is non-null in the body after `require members`.
#[test]
fn t06_require_carries_admission() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=public\n  require members\n  do\n   let v = actor.email_verified\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "post-require admission: {diags:?}");
}

/// (T06) An admitting `if` condition admits its then-branch only.
#[test]
fn t06_if_branch_admits() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=public\n  do\n   if members\n    let v = actor.email_verified\n   else\n    let w = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "if-branch admission: {diags:?}");
}

/// (T06) `by=r(actor)` tests the caller: the body is admitted (no
/// `E3003`), while the `by=` subject itself still needs a proof it
/// cannot supply (`E3001`) and the call form stays redundant
/// (`E4020` is the pre-existing effects-pass rule, out of T06 scope).
#[test]
fn t06_role_call_on_caller_admits_body() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=r(actor)\n  do\n   let v = actor.email_verified\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001", "E4020"], "{diags:?}");
}

/// (T06) `by=r or q` admits: either arm proves an authenticated
/// caller (Inbox scenario shape).
#[test]
fn t06_by_or_of_roles_admits() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n role q\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=r or q\n  do\n   let v = actor.email_verified\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "by= or-of-roles admits: {diags:?}");
}

/// (T06) `by=not public` admits: a non-public request is
/// authenticated (pins the false-polarity rule).
#[test]
fn t06_by_not_public_admits() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=not public\n  do\n   let v = actor.email_verified\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "by=not public admits: {diags:?}");
}

/// (T06 no-leak) A role test on another subject never narrows the
/// caller: `by=r(owner)` leaves `actor` nullable.
#[test]
fn t06_no_leak_by_role_on_other_subject() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n policy M read=members\nWhen\n scenario s(owner:user) by=r(owner)\n  require actor.email_verified\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T06 no-leak) A role test on another subject in a guard never
/// narrows the caller either (contract §9).
#[test]
fn t06_no_leak_require_role_on_other_subject() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n policy M read=members\nWhen\n scenario s(owner:user) by=public\n  require r(owner)\n  do\n   let v = actor.email_verified\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T06 no-leak) A non-predicate call never admits, even on the
/// caller: `read=maybe(actor)` leaves `where=` actor nullable
/// (Chat `can_use` shape).
#[test]
fn t06_no_leak_derive_call_never_admits() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n derive maybe(person:user?):bool = person!=null\n derive ok(person:user):bool = person.id != \"\"\n policy M read=maybe(actor) where=ok(actor)\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T06) Public actor stays nullable: an unguarded non-null use in a
/// `by=public` guard is `E3001`.
#[test]
fn t06_public_guard_use_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=members\nWhen\n scenario s() by=public\n  require ok(actor)\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T06) `public` in an `or` admits nothing: `by=public or r` leaves
/// `actor` nullable (the public arm admits unauthenticated calls).
#[test]
fn t06_or_with_public_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=public or r\n  do\n   let v = actor.email_verified\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T06) CRUD `by=public` admits nothing into `when=`.
#[test]
fn t06_crud_public_when_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n derive ok(person:user):bool = person.id != \"\"\n policy M read=members\nWhen\n crud M by=public fields=t when=ok(actor)\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T06) Preauthorization stays nullable: a parameter default cannot
/// use the operation's admission, even under an admitting `by=`
/// (DESIGN signature rule).
#[test]
fn t06_preauthorization_default_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n role r\n M { t:text }\n policy M read=members\nWhen\n scenario s(x:text = actor.id) by=r\n  do\n   let y = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T06) Trusted handlers keep `actor=null`: payload reads pass but
/// the caller stays absent (payload users never become callers).
#[test]
fn t06_trusted_actor_stays_null() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { s:enum(a,b)=a }\n policy M read=members\n event Due { item:M }\nWhen\n scenario h on=Due\n  require event.item.s==a\n  require actor.email_verified\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T06 layer-2 stay) A state-reading call remains gated from pure
/// positions until the T32 read contract is adopted (R26 layer 2).
#[test]
fn t06_bounded_read_stays_gated() {
    let catalog = fixture_with(READ_JSON);
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n derive f(p:user):bool = p.id != \"\" and needy(p)\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
}

// --- T07 filtered row facts: `where` null tests narrow the selected row ---
//
// A `where` passes only rows satisfying it, so its true-facts narrow
// the row alias in following clauses (`select`/`order`/later
// `where`), the collection `row` (plus the alias) in list/table
// bodies, and the item in `for` bodies. Facts stay keyed on the
// alias declaration (T03 §6): sibling and nested aliases never
// share them; outer facts flow inward through ordinary nesting.

/// (T07) Rent:374 shape: the `where` null test narrows the alias in
/// the `select` dereference.
#[test]
fn t07_where_narrows_select_deref() {
    let catalog = fixture();
    let src = "app T\nGiven\n V { from:text }\n W { value:V? }\n policy V read=members\n policy W read=members\nWhen\n scenario s() by=members\n  do\n   let xs = W as w where w.value!=null select w.value.from\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "where narrows select deref: {diags:?}");
}

/// (T07) Rent:245 shape: `select` of the narrowed member unwraps the
/// element type (a `for` over it sees non-null items).
#[test]
fn t07_where_narrows_select_element() {
    let catalog = fixture();
    let src = "app T\nGiven\n V { from:text }\n W { value:V? }\n policy V read=members\n policy W read=members\nWhen\n scenario s() by=members\n  do\n   for v in W as w where w.value!=null select w.value limit=1\n    let t = v.from\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "where narrows select element: {diags:?}");
}

/// (T07) Rent:377 shape: an outer `where` fact flows inward into a
/// nested query's `select` (the continuation contract allows inward
/// flow through ordinary expression nesting).
#[test]
fn t07_outer_where_flows_into_nested_select() {
    let catalog = fixture();
    let src = "app T\nGiven\n V { from:text }\n W { value:V? }\n N { t:text }\n policy V read=members\n policy W read=members\n policy N read=members\nWhen\n scenario s() by=members\n  do\n   let xs = W as fact where fact.value!=null select (N as n select fact.value.from)\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "outer where flows inward: {diags:?}");
}

/// (T07) CRM:414-420 shape: the table `row` inherits the domain
/// `where` facts (nullable arithmetic checks clean in the body).
#[test]
fn t07_table_row_inherits_where() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { due:datetime? }\n policy M read=members\nWhen\nThen\n page /t title=\"T\"\n  table M as m where m.due!=null columns=due\n   countdown row.due-now\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "table row inherits where: {diags:?}");
}

/// (T07) Selected-children iteration (Rent:627 `for` shape): the
/// for-item inherits the domain `where` facts in the body.
#[test]
fn t07_for_item_inherits_where() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   for x in M as m where m.box!=null limit=1\n    let t = x.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "for item inherits where: {diags:?}");
}

/// (T07) CRM:180 shape (bodies may name the alias): the list body
/// sees the domain alias facts through the alias spelling too.
#[test]
fn t07_list_body_names_alias() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B? }\n policy B read=members\n policy M read=members\nWhen\nThen\n page /t title=\"T\"\n  list M as m where m.box!=null columns=box\n   text m.box.label\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "list body names alias: {diags:?}");
}

/// (T07) Outer `require` facts flow inward into a query `select`
/// through ordinary nesting (no regression of the inward path).
#[test]
fn t07_outer_require_flows_into_select() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B? }\n N { t:text }\n policy B read=members\n policy M read=members\n policy N read=members\nWhen\n scenario s(m:M?) by=members\n  do\n   let a = m\n   require a!=null and a.box!=null\n   let xs = N as n select a.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "outer require flows inward: {diags:?}");
}

/// (T07) A `select` reshapes the row, so the collection still seeds
/// the alias facts (the alias denotes a selected row) even though
/// the `row` remap is skipped.
#[test]
fn t07_table_select_keeps_alias_facts() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B?, name:text }\n policy B read=members\n policy M read=members\nWhen\nThen\n page /t title=\"T\"\n  table M as m where m.box!=null select m.name columns=name\n   text m.box.label\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "select keeps alias facts: {diags:?}");
}

/// (T07 alias control) Two handles over one model: the filtered
/// alias checks clean while the unfiltered handle keeps no facts.
#[test]
fn t07_alias_second_handle_keeps_no_facts() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let a = M as m where m.box!=null select m.box.label\n   let b = M as m2 select m2.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T07 sibling control) Two child selections side by side: the
/// filtered child grants nothing to its sibling.
#[test]
fn t07_sibling_child_keeps_no_facts() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { t:text }\n B { label:text }\n C in P { box:B? }\n policy P read=members\n policy B read=members\n policy C read=members\nWhen\n scenario s(p:P) by=members\n  do\n   let x = p.C as a where a.box!=null select a.box.label\n   let y = p.C as b select b.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T07 nested-row control) An inner selection's facts never leak
/// outward: a later same-spelling alias is its own declaration.
#[test]
fn t07_nested_inner_keeps_no_outward_facts() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let inner_ok = M as m select (M as m where m.box!=null select m.box.label)\n   let outer_bad = M as m select m.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T07) A `select` reshapes the for-domain element, so no row
/// facts remap to the item: `x.box` on the projected `text` is
/// `E2013`, never silently narrowed.
#[test]
fn t07_for_select_blocks_item_remap() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B?, name:text }\n policy B read=members\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   for x in M as m where m.box!=null select m.name limit=1\n    let t = x.box\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T07) A `select` reshapes the collection row, so no row facts
/// remap to `row`: `row.box` on the projected `text` is `E2013`,
/// never silently narrowed.
#[test]
fn t07_table_select_blocks_row_remap() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B?, name:text }\n policy B read=members\n policy M read=members\nWhen\nThen\n page /t title=\"T\"\n  table M as m where m.box!=null select m.name columns=name\n   text row.box\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T07) Body writes drop seeded item facts through the ordinary
/// invalidation rule (T03 §8): after `set x {box=null}` the
/// member reads nullable again.
#[test]
fn t07_for_body_set_drops_item_fact() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   for x in M as m where m.box!=null limit=1\n    set x {box=null}\n    let t = x.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T07) Contract fidelity: the true-continuation of an OR-`where`
/// carries nothing (T03 §3), so the `select` still fails.
#[test]
fn t07_where_or_carries_nothing() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B?, flag:bool }\n policy B read=members\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let xs = M as m where m.box!=null or m.flag select m.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T07) Contract fidelity: a safe-access null test in `where`
/// establishes nothing (T03 IC7), so the `select` still fails.
#[test]
fn t07_where_safe_access_grants_nothing() {
    let catalog = fixture();
    let src = "app T\nGiven\n B { label:text }\n M { box:B? }\n policy B read=members\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let xs = M as m where m.box?.label!=null select m.box.label\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

/// (T10) Fixture contract literal: a nested value validates
/// closed-recursively (Qualification shape) — nested contract, bare
/// enum case, omitted nullable/default/ordinary-array members and a
/// model reference all check clean.
#[test]
fn t10_fixture_nested_literal_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Inner { a:text }\n contract Q { name:text, inner:Inner, s:enum(x,y), n:int?, d:int=3, tags:text[], m:M? }\n M { t:text }\n Holder { value:Q }\n policy M read=members\n policy Holder read=members\n fixture m0=M {t=\"x\"}\n fixture h0=Holder {value={name=\"n\",inner={a=\"a\"},s=x,m=m0}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nested fixture literal: {diags:?}");
}

/// (T10) `create` with a nested contract literal checks clean
/// (scenario parameters supply model references).
#[test]
fn t10_create_nested_literal_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Inner { a:text }\n contract Q { name:text, inner:Inner, s:enum(x,y) }\n Holder { value:Q }\n policy Holder read=members\nWhen\n scenario s() by=members\n  do\n   create Holder {value={name=\"n\",inner={a=\"a\"},s=y}} as h\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nested create literal: {diags:?}");
}

/// (T10) `set` with a nullable contract literal checks clean
/// (executed-party snapshot shape).
#[test]
fn t10_set_nullable_literal_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Snap { title:text, owner:text }\n M { snap:Snap? }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  do\n   set m {snap={title=\"t\",owner=\"o\"}}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nullable set literal: {diags:?}");
}

/// (T10) A `send` request carrying a nested contract literal checks
/// clean, including the nested bare enum case (alert shape).
#[test]
fn t10_send_request_literal_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Alert { source:text, kind:enum(info,urgent) }\n contract Ack { ok:bool }\n capability Mail version=1\n  notify(value:Alert) -> Ack\nWhen\n scenario s() by=members\n  do\n   send Mail.notify {value={source=\"s\",kind=urgent}} as attempt\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nested send literal: {diags:?}");
}

/// (T10) A delivery recipe whose request carries a nested contract
/// literal checks clean (Catch/Check alert fixture shape).
#[test]
fn t10_recipe_request_literal_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Alert { source:text, kind:enum(info,urgent) }\n contract Ack { ok:bool }\n capability Mail version=1\n  notify(value:Alert) -> Ack\n fixture attempt=Mail.notify {request={value={source=\"s\",kind=info}}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nested recipe literal: {diags:?}");
}

/// (T10 C2) `examples event={...}` inherits the handler's event type:
/// nested bare cases claim instead of erroring `E2001`.
#[test]
fn t10_examples_event_claims_nested_cases() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { s:enum(a,b)=a }\n policy M read=members\n contract V { n:int, s:enum(a,b) }\n event Due { item:M, value:V }\nWhen\n scenario h on=Due\n  require event.item.s==a\n  do\n   let x = 1\n  examples event={value={n=1,s=a}}\n   event.value.n -> event.value.n\n   1 -> 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "examples event claims cases: {diags:?}");
}

/// (T10) Arrays of contracts validate element-wise, including under a
/// nullable array expectation.
#[test]
fn t10_nested_array_of_contracts_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Line { sku:text, n:int }\n contract Q { name:text, lines:Line[]?, s:enum(x,y) }\n Holder { value:Q }\n policy Holder read=members\n fixture h0=Holder {value={name=\"n\",lines=[{sku=\"a\",n=1},{sku=\"b\",n=2}],s=x}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "array of contract literals: {diags:?}");
}

/// (T10) A supplied server-initialized field inside a literal
/// validates strictly (fixtures are stored snapshots; the values
/// `create` mode agrees) and is never required when omitted.
#[test]
fn t10_literal_supplied_server_field_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Q { name:text, stamp:datetime server=now }\n Holder { value:Q }\n policy Holder read=members\n fixture h0=Holder {value={name=\"n\"}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "omitted server literal field: {diags:?}");
}

/// (T10) Unknown keys inside a literal are `E2013` (closed shapes).
#[test]
fn t10_unknown_nested_key_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Q { name:text }\n Holder { value:Q }\n policy Holder read=members\n fixture h0=Holder {value={name=\"n\",bogus=1}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (T10) A missing required nested field is `E3001` naming the field.
#[test]
fn t10_missing_nested_required_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Inner { a:text }\n contract Q { name:text, inner:Inner }\n Holder { value:Q }\n policy Holder read=members\n fixture h0=Holder {value={name=\"n\"}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("'inner'"),
        "names the missing field: {}",
        diags[0].message
    );
}

/// (T10) A nested name outside the enum domain stays `E2001` (no
/// claiming, no coercion).
#[test]
fn t10_wrong_nested_enum_case_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Q { name:text, s:enum(x,y) }\n Holder { value:Q }\n policy Holder read=members\n fixture h0=Holder {value={name=\"n\",s=nope}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2001"], "{diags:?}");
}

/// (T10) A mistyped nested scalar is `E3001` (no broad coercion).
#[test]
fn t10_wrong_nested_scalar_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Q { name:text, n:int }\n Holder { value:Q }\n policy Holder read=members\n fixture h0=Holder {value={name=\"n\",n=\"s\"}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T10) Explicit null for a non-nullable nested field is `E3001`.
#[test]
fn t10_null_for_nonnull_nested_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Q { name:text }\n Holder { value:Q }\n policy Holder read=members\n fixture h0=Holder {value={name=null}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
}

/// (T10) A bare literal never forges a model reference: `E3015`
/// keeps identity by reference only.
#[test]
fn t10_literal_for_model_ref_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n Holder { m:M }\n policy M read=members\n policy Holder read=members\n fixture h0=Holder {m={t=\"x\"}}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
}

/// (T10) A bare literal never forges a delivery handle: `E3015`
/// keeps protected provenance unfabricable.
#[test]
fn t10_literal_for_delivery_rejected() {
    let catalog = fixture();
    let src = "package p\n use p {Mail as Box} from=deployment.mail\n Given\n  export capability Mail version=1\n   send(to:text) -> Ack\n  contract Ack { ok:bool }\n  M { h:delivery(Box.send)? }\n  policy M read=members\n  fixture f=M {h={id=\"x\",operation=\"s\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
}

/// (T10/R18) Cross-enum comparison stays rejected: distinct enum
/// types never compare (T36 owns any nominal mapping).
#[test]
fn t10_cross_enum_comparison_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { a:enum(x,y), b:enum(x,y,z) }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require m.a==m.b\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3002"], "{diags:?}");
}

/// (T30) An ordinary parameter merely named `event` mutates as any
/// stored record (R15 CanEvent:73: provenance from resolution, never
/// the parameter name).
#[test]
fn t30_param_named_event_mutable() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s(event:M) by=members\n  do\n   set event {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "param named event mutates: {diags:?}");
}

/// (T30) Rename invariance: the same valid and invalid writes check
/// identically whether the parameter is named `event` or `booking`.
#[test]
fn t30_param_rename_invariance() {
    let catalog = fixture();
    let valid_event = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s(event:M) by=members\n  do\n   set event {t=\"x\"}\nThen\n";
    let valid_booking = valid_event
        .replace("event:M", "booking:M")
        .replace("set event {", "set booking {");
    let diags_event = check(valid_event, Some(&catalog));
    let diags_booking = check(&valid_booking, Some(&catalog));
    assert!(diags_event.is_empty(), "event spelling: {diags_event:?}");
    assert!(
        diags_booking.is_empty(),
        "booking spelling: {diags_booking:?}"
    );
    let invalid_event = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s(event:M) by=members\n  do\n   set event {bogus=1}\nThen\n";
    let invalid_booking = invalid_event
        .replace("event:M", "booking:M")
        .replace("set event {", "set booking {");
    let diags_event = check(invalid_event, Some(&catalog));
    let diags_booking = check(&invalid_booking, Some(&catalog));
    assert_eq!(codes(&diags_event), vec!["E2013"], "{diags_event:?}");
    assert_eq!(
        codes(&diags_booking),
        codes(&diags_event),
        "{diags_booking:?}"
    );
}

/// (T30) A verified declared reference mutates its stored row
/// (R15 CanCheck:128 `set event.check`).
#[test]
fn t30_verified_reference_write_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n event Due { item:M, n:int }\nWhen\n scenario h on=Due\n  do\n   set event.item {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "verified reference writes: {diags:?}");
}

/// (T30) Payload value data stays read-only: `set` through an
/// int-typed event member is `E3009`.
#[test]
fn t30_reference_value_data_readonly() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n event Due { item:M, n:int }\nWhen\n scenario h on=Due\n  do\n   set event.n {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30) The hook snapshot itself stays immutable: `set event.before`
/// in an update hook is `E3009`.
#[test]
fn t30_snapshot_before_readonly() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text, n:int=0 }\n policy M read=members\nWhen\n scenario fix on=M.update\n  do\n   set event.before {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30) Pending-source deletion stays rejected: `delete event.after`
/// and `delete event.before` are `E3009`.
#[test]
fn t30_pending_delete_rejected() {
    let catalog = fixture();
    let src_after = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario fix on=M.create\n  do\n   delete event.after\nThen\n";
    let diags = check(src_after, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
    let src_before = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario fix on=M.update\n  do\n   delete event.before\nThen\n";
    let diags = check(src_before, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30) `event.after` outside a create/update hook stays `E3009`
/// (even though the payload has no `after` member to misread).
#[test]
fn t30_after_outside_hook_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n event Due { item:M }\nWhen\n scenario h on=Due\n  do\n   set event.after {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30) A delete hook can reject but cannot adjust: `set
/// event.after` there is `E3009`.
#[test]
fn t30_delete_hook_cannot_adjust() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario fix on=M.delete\n  do\n   set event.after {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30/C6) Hook reads carry the pending record's type: computed set
/// values, `parent=event.after` and member reads check clean (an
/// `{opaque}` payload would draw `E3001` on each).
#[test]
fn t30_hook_after_typed() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text, n:int=0, flag:bool=true }\n Child in M { u:int=0 }\n policy M read=members\n policy Child read=members\nWhen\n scenario fix on=M.create\n  do\n   set event.after {n=event.after.n+1}\n   create Child {parent=event.after,u=event.after.n} as c\n   let ok = event.after.flag\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "typed hook reads: {diags:?}");
}

/// (T30/C6) Update-hook snapshot reads carry the record's type.
#[test]
fn t30_hook_before_typed() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text, n:int=0 }\n policy M read=members\nWhen\n scenario fix on=M.update\n  do\n   set event.after {n=event.before.n+1}\n   let same = event.before.t==event.after.t\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "typed snapshot reads: {diags:?}");
}

/// (T30) Deleting through a verified reference matches its let-alias
/// exactly (direct path introduces no new permission).
#[test]
fn t30_delete_via_reference_matches_alias() {
    let catalog = fixture();
    let direct = "app T\nGiven\n M { t:text }\n policy M read=members\n event Due { item:M }\nWhen\n scenario h on=Due\n  do\n   delete event.item\nThen\n";
    let diags = check(direct, Some(&catalog));
    assert!(diags.is_empty(), "direct reference delete: {diags:?}");
    let aliased = "app T\nGiven\n M { t:text }\n policy M read=members\n event Due { item:M }\nWhen\n scenario h on=Due\n  do\n   let x = event.item\n   delete x\nThen\n";
    let diags = check(aliased, Some(&catalog));
    assert!(diags.is_empty(), "aliased reference delete: {diags:?}");
}

/// (T30) A live row reached through the snapshot mutates on its own
/// provenance (R15 CanOnboard:51 `set event.before.parent`).
#[test]
fn t30_before_parent_row_mutable() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { n:int=0 }\n C in P { u:int=0 }\n policy P read=members\n policy C read=members\nWhen\n scenario fix on=C.update\n  do\n   set event.before.parent {n=event.before.parent.n+1}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "row through snapshot mutates: {diags:?}");
}

/// (T30) A nullable event path stays rejected (R15 CanEvent:254: no
/// `?.` in `set` targets, so the unguarded target fails closed).
#[test]
fn t30_nullable_event_path_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n event Due { item:M, opt:M? }\nWhen\n scenario h on=Due\n  do\n   set event.opt {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30) The whole handler payload stays read-only: bare `set event`
/// in a handler is `E3009`.
#[test]
fn t30_whole_payload_readonly() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n event Due { item:M }\nWhen\n scenario h on=Due\n  do\n   set event {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30) Opaque handler payloads fail closed: `set` into a committed
/// change-event member is `E3009`, never silently accepted.
#[test]
fn t30_opaque_payload_fail_closed() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario h on=M.created\n  do\n   set event.snapshot {t=\"x\"}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3009"], "{diags:?}");
}

/// (T30) `set` on a parameter named `event` drops that parameter's
/// member-path facts (resolution-based invalidation, T03 §8): the
/// pre-`set` non-null fact no longer reaches the later member read.
#[test]
fn t30_set_param_event_drops_param_facts() {
    let catalog = fixture();
    let src = "app T\nGiven\n P { t:text }\n M { ref:P?, u:int=0 }\n policy P read=members\n policy M read=members\nWhen\n scenario s(event:M) by=members\n  require event.ref!=null\n  do\n   set event {u=1}\n   let v = event.ref.t\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3003"], "{diags:?}");
}

// --- D02b: semantic join for inline descriptions ---------------------------
//
// Static `desc=` values (literals, descriptors with variants, message
// paths), the legacy `@{desc}` spelling and attached `#` sets resolve
// into one checked-description slot per field/parameter declaration
// (`EffectTables::checked_descriptions`). Non-static or non-message
// values fail at check level with located diagnostics; the parser's
// dynamic/call/query rejections keep no check-level cascade.

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

/// Check one source through the full pipeline without a catalog
/// (description tests use no builtins), returning the checked program
/// plus sorted diagnostics.
fn check_full(src: &str) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (program, mut diags) = check_program(&db, &[id], None);
    diags.sort_by(|a, b| {
        (a.primary.start, a.primary.end, &a.code).cmp(&(b.primary.start, b.primary.end, &b.code))
    });
    (program, diags)
}

/// Checked description for the field/parameter declaration containing
/// the `occurrence`-th `needle`, if the slot is present. Owner spans
/// include leading trivia (lossless builder), so matching is by
/// containment, not exact start.
fn seam_for<'p>(
    program: &'p CheckedProgram,
    src: &str,
    needle: &str,
    occurrence: usize,
) -> Option<&'p CheckedDescription> {
    let (start, _) = span_of(src, needle, occurrence);
    program.effects.checked_descriptions.values().find(|d| {
        (d.owner.kind == SyntaxKind::Field as u8 || d.owner.kind == SyntaxKind::Parameter as u8)
            && d.owner.start <= start
            && start < d.owner.end
    })
}

/// Assert a description location covers exactly the `occurrence`-th
/// `needle` plus leading trivia (the lossless builder keeps the gap
/// inside the value node).
#[track_caller]
fn assert_location(
    src: &str,
    node: &canlang_compiler::analysis::NodeKey,
    needle: &str,
    occurrence: usize,
) {
    let (start, end) = span_of(src, needle, occurrence);
    assert_eq!(node.end, end, "location end");
    assert!(node.start <= start, "location start");
    assert!(
        src[node.start as usize..start as usize].trim().is_empty(),
        "only trivia precedes the value"
    );
}

/// Minimal clean source with one model field under test.
fn d02b_field_src(field: &str) -> String {
    format!("app Shop\nGiven\n Gadget {{ {field} }}\n policy Gadget read=members\nWhen\nThen\n")
}

/// Minimal clean source with scenario parameters under test.
fn d02b_param_src(params: &str) -> String {
    format!(
        "app Shop\nGiven\n Gadget {{ title:text }}\n policy Gadget read=members\nWhen\n scenario approve({params}) by=members\n  do\n   let x = 1\nThen\n"
    )
}

/// (D02b) Plain-string `desc=` checks clean on a field and on a
/// parameter; the seam holds the source text with no variants, the
/// authoring source language and the `desc=` location, while an
/// undescribed sibling has no entry (absence).
#[test]
fn d02b_inline_plain_on_field_and_param() {
    let src = d02b_field_src("title:text desc=\"Display title.\", stock:int");
    let (program, diags) = check_full(&src);
    assert!(diags.is_empty(), "plain desc: {diags:?}");
    let entry = seam_for(&program, &src, "title:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "Display title.");
    assert!(entry.variants.is_empty());
    assert_eq!(entry.source_lang, "en");
    assert!(entry.message.is_none());
    assert_location(&src, &entry.node, "desc=\"Display title.\"", 1);
    assert!(
        seam_for(&program, &src, "stock:int", 1).is_none(),
        "undescribed field has no entry"
    );

    let src = d02b_param_src("note:text desc=\"Optional note.\"");
    let (program, diags) = check_full(&src);
    assert!(diags.is_empty(), "plain param desc: {diags:?}");
    let entry = seam_for(&program, &src, "note:text", 1).expect("described param has an entry");
    assert_eq!(entry.source, "Optional note.");
    assert!(entry.variants.is_empty());
    assert_eq!(entry.source_lang, "en");
    assert_location(&src, &entry.node, "desc=\"Optional note.\"", 1);
}

/// (D02b) Inline `desc=` variants resolve in written order, with `null`
/// kept as an absent translation (distinct from empty text).
#[test]
fn d02b_inline_variants_ordered() {
    let src = d02b_field_src(
        "name:text desc=\"The name shown to customers.\"@{nl=\"De naam die klanten zien.\", fr=null}",
    );
    let (program, diags) = check_full(&src);
    assert!(diags.is_empty(), "desc variants: {diags:?}");
    let entry = seam_for(&program, &src, "name:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "The name shown to customers.");
    let variants: Vec<(&str, Option<&str>)> = entry
        .variants
        .iter()
        .map(|v| (v.locale.as_str(), v.value.as_deref()))
        .collect();
    assert_eq!(
        variants,
        vec![("nl", Some("De naam die klanten zien.")), ("fr", None),]
    );
    assert_location(
        &src,
        &entry.node,
        "desc=\"The name shown to customers.\"@{nl=\"De naam die klanten zien.\", fr=null}",
        1,
    );
}

/// (D02b) An authored-empty `desc=""` checks clean and keeps a present
/// slot with empty source text (absence-vs-empty distinct).
#[test]
fn d02b_inline_empty_is_present() {
    let src = d02b_field_src("nick:text desc=\"\"");
    let (program, diags) = check_full(&src);
    assert!(diags.is_empty(), "empty desc: {diags:?}");
    let entry = seam_for(&program, &src, "nick:text", 1).expect("empty desc keeps a present slot");
    assert_eq!(entry.source, "");
    assert!(entry.variants.is_empty());
}

/// (D02b) A `desc=` message path resolves to the message's wording
/// (source plus variants) even when the message is declared later in
/// the module (forward reference).
#[test]
fn d02b_message_reference_resolves_wording() {
    let src = "app Shop\nGiven\n Gadget { title:text desc=title_msg }\n policy Gadget read=members\n message title_msg = \"Display title.\"@{nl=\"Titel.\"}\nWhen\nThen\n";
    let (program, diags) = check_full(src);
    assert!(diags.is_empty(), "message desc ref: {diags:?}");
    let entry = seam_for(&program, src, "title:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "Display title.");
    let variants: Vec<(&str, Option<&str>)> = entry
        .variants
        .iter()
        .map(|v| (v.locale.as_str(), v.value.as_deref()))
        .collect();
    assert_eq!(variants, vec![("nl", Some("Titel."))]);
    assert_eq!(entry.source_lang, "en");
    let message = entry.message.expect("reference records its message");
    assert_eq!(program.symbols[message.0 as usize].name, "title_msg");
    assert_location(src, &entry.node, "desc=title_msg", 1);
}

/// (D02b) A cross-package `desc=` message path resolves under the
/// referenced message's owning source language, not the author's.
#[test]
fn d02b_message_reference_cross_module_lang() {
    let src = "app T uses=[p,q]\npackage p source=\"nl\"\n Given\n  export message title_msg = \"Titel.\"@{en=\"Title.\"}\n When\n Then\npackage q\n use p {title_msg}\n Given\n  Gadget { title:text desc=p.title_msg }\n  policy Gadget read=members\n When\n Then\n";
    let (program, diags) = check_full(src);
    assert!(diags.is_empty(), "cross-package desc ref: {diags:?}");
    let entry = seam_for(&program, src, "title:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "Titel.");
    let variants: Vec<(&str, Option<&str>)> = entry
        .variants
        .iter()
        .map(|v| (v.locale.as_str(), v.value.as_deref()))
        .collect();
    assert_eq!(variants, vec![("en", Some("Title."))]);
    assert_eq!(entry.source_lang, "nl");
}

/// (D02b) The legacy `@{desc="..."}` spelling adapts as source text
/// with no variants under the authoring language.
#[test]
fn d02b_legacy_annotation_adapts() {
    let src = d02b_field_src("title:text @{desc=\"Display title.\"}");
    let (program, diags) = check_full(&src);
    assert!(diags.is_empty(), "legacy desc: {diags:?}");
    let entry = seam_for(&program, &src, "title:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "Display title.");
    assert!(entry.variants.is_empty());
    assert_eq!(entry.source_lang, "en");
    assert!(entry.message.is_none());
    assert_location(&src, &entry.node, "@{desc=\"Display title.\"}", 1);
}

/// (D02b) An attached `#` set on a field feeds the same slot: prose
/// plus suffix variants, located at the `#` line.
#[test]
fn d02b_attached_hash_feeds_slot() {
    let src = "app Shop\nGiven\n Gadget {\n  # Display title. @{nl=\"Titel.\"}\n  title:text\n }\n policy Gadget read=members\nWhen\nThen\n";
    let (program, diags) = check_full(src);
    assert!(diags.is_empty(), "attached desc: {diags:?}");
    let entry = seam_for(&program, src, "title:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "Display title.");
    let variants: Vec<(&str, Option<&str>)> = entry
        .variants
        .iter()
        .map(|v| (v.locale.as_str(), v.value.as_deref()))
        .collect();
    assert_eq!(variants, vec![("nl", Some("Titel."))]);
    assert_location(src, &entry.node, "# Display title. @{nl=\"Titel.\"}", 1);
}

/// (D02b) An attached `#= path` set on a field resolves to the
/// message's wording like an inline path.
#[test]
fn d02b_attached_reference_resolves() {
    let src = "app Shop\nGiven\n message title_msg = \"Display title.\"@{nl=\"Titel.\"}\n Gadget {\n  #= title_msg\n  title:text\n }\n policy Gadget read=members\nWhen\nThen\n";
    let (program, diags) = check_full(src);
    assert!(diags.is_empty(), "attached desc ref: {diags:?}");
    let entry = seam_for(&program, src, "title:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "Display title.");
    assert_eq!(entry.source_lang, "en");
    let message = entry.message.expect("reference records its message");
    assert_eq!(program.symbols[message.0 as usize].name, "title_msg");
}

/// (D02b) `label=` after `desc=` still decodes: the seam holds the
/// description while the effects label slot stays populated.
#[test]
fn d02b_label_after_desc_still_decodes() {
    let src = d02b_field_src("title:text desc=\"Display title.\" label=\"Title\"");
    let (program, diags) = check_full(&src);
    assert!(diags.is_empty(), "desc plus label: {diags:?}");
    let entry = seam_for(&program, &src, "title:text", 1).expect("described field has an entry");
    assert_eq!(entry.source, "Display title.");
    let model = program
        .symbols
        .iter()
        .find(|s| matches!(s.kind, SymbolKind::Model { .. }))
        .expect("model symbol");
    let data = program
        .effects
        .models
        .get(&model.id)
        .expect("model effects row");
    assert!(
        data.fields.iter().any(|f| f.label.is_some()),
        "label survives desc="
    );
}

/// (D02b) A `desc=` path naming a non-message is `E3016`, located at
/// the path.
#[test]
fn d02b_non_message_reference_rejected() {
    let src = d02b_field_src("title:text desc=Gadget");
    let diags = check(&src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0].message.contains("must reference a message"),
        "{}",
        diags[0].message
    );
    assert_eq!(
        (diags[0].primary.start, diags[0].primary.end),
        span_of(&src, "Gadget", 2)
    );
}

/// (D02b) A `desc=` path naming a parameterized message is `E3016`.
#[test]
fn d02b_parameterized_message_rejected() {
    let src = "app Shop\nGiven\n message greet(name:text) = \"Hi {name}\"@{}\n Gadget { title:text desc=greet }\n policy Gadget read=members\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("parameterized messages need call syntax"),
        "{}",
        diags[0].message
    );
    assert_eq!(
        (diags[0].primary.start, diags[0].primary.end),
        span_of(src, "greet", 2)
    );
}

/// (D02b) A `desc=` path naming nothing is `E2001` with no `E3016`
/// follow-on.
#[test]
fn d02b_unresolved_reference_rejected() {
    let src = d02b_field_src("title:text desc=nosuch");
    let diags = check(&src, None);
    assert_eq!(codes(&diags), vec!["E2001"], "{diags:?}");
    assert_eq!(
        (diags[0].primary.start, diags[0].primary.end),
        span_of(&src, "nosuch", 1)
    );
}

/// (D02b) An invalid locale tag in a `desc=` suffix is `E3016`,
/// located at the tag.
#[test]
fn d02b_bad_locale_rejected() {
    let src = d02b_field_src("title:text desc=\"Display title.\"@{a=\"Titel.\"}");
    let diags = check(&src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0].message.contains("not a valid language tag"),
        "{}",
        diags[0].message
    );
    let (start, _) = span_of(&src, "a=\"Titel.\"", 1);
    assert_eq!(
        (diags[0].primary.start, diags[0].primary.end),
        (start, start + 1)
    );
}

/// (D02b) A `desc=` variant repeating the module source language is
/// `E3016`, located at the tag.
#[test]
fn d02b_source_repeat_rejected() {
    let src = "app Shop source=\"nl\"\nGiven\n Gadget { title:text desc=\"Titel.\"@{nl=\"Titel.\"} }\n policy Gadget read=members\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0].message.contains("repeats the source language"),
        "{}",
        diags[0].message
    );
    let (start, _) = span_of(src, "nl=", 1);
    assert_eq!(
        (diags[0].primary.start, diags[0].primary.end),
        (start, start + 2)
    );
}

/// (D02b) Navigation past a message in a `desc=` path is `E2013`
/// (messages have no members).
#[test]
fn d02b_member_past_message_rejected() {
    let src = "app Shop\nGiven\n message title_msg = \"Display title.\"@{}\n Gadget { title:text desc=title_msg.foo }\n policy Gadget read=members\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
}

/// (D02b) A dynamic `desc=` value stays a parse-level rejection: the
/// checker adds no `E3016` cascade.
#[test]
fn d02b_dynamic_stays_parse_only() {
    let src = d02b_field_src("title:text desc=42");
    let diags = check(&src, None);
    assert!(codes(&diags).contains(&"E1214"), "{diags:?}");
    assert!(!codes(&diags).contains(&"E3016"), "{diags:?}");
}

/// (D02b) A parameterized `desc=` call stays a parse-level rejection:
/// the checker adds no `E3016` cascade.
#[test]
fn d02b_parameterized_call_stays_parse_only() {
    let src = d02b_field_src("title:text desc=title_msg(x)");
    let diags = check(&src, None);
    assert!(codes(&diags).contains(&"E1214"), "{diags:?}");
    assert!(!codes(&diags).contains(&"E3016"), "{diags:?}");
}

/// (D02b) A record-query `desc=` value stays a parse-level rejection:
/// the checker adds no `E3016` cascade.
#[test]
fn d02b_record_query_stays_parse_only() {
    let src = d02b_field_src("title:text desc=Gadget where active");
    let diags = check(&src, None);
    assert!(codes(&diags).contains(&"E1214"), "{diags:?}");
    assert!(!codes(&diags).contains(&"E3016"), "{diags:?}");
}

/// (T11) Integral bounds inhabit a uniquely-decimal field
/// (CanAffiliate:23 `rate:decimal min=0 max=1`).
#[test]
fn t11_decimal_bounds_accept_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { rate:decimal min=0 max=1 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "integral decimal bounds: {diags:?}");
}

/// (T11) An integral default inhabits a decimal field
/// (CanInvoice:104 `quantity:decimal=1 min=0`).
#[test]
fn t11_decimal_default_accepts_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { quantity:decimal=1 min=0 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "integral decimal default: {diags:?}");
}

/// (T11) An integral spelling inhabits a nullable decimal field.
#[test]
fn t11_nullable_decimal_accepts_integral() {
    let catalog = fixture();
    let src =
        "app T\nGiven\n M { d:decimal? }\n policy M read=members\n fixture f=M {d=1}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nullable decimal fixture: {diags:?}");
}

/// (T11) `create` field values accept integral spellings for decimal
/// fields.
#[test]
fn t11_create_accepts_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { d:decimal }\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   create M {d=1} as m\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "integral create value: {diags:?}");
}

/// (T11) Fixture recipes accept integral spellings for decimal fields
/// (CanMember:216 `granted=10`).
#[test]
fn t11_fixture_accepts_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { granted:decimal }\n policy M read=members\n fixture f=M {granted=10}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "integral fixture value: {diags:?}");
}

/// (T11) Nested structural literals accept integral spellings for
/// decimal leaves (CanRent:296 `quantity=1`).
#[test]
fn t11_structural_literal_accepts_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n contract Line { title:text, quantity:decimal }\n Holder { lines:Line[] }\n policy Holder read=members\n fixture h=Holder {lines=[{title=\"Room\",quantity=1}]}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nested integral literal: {diags:?}");
}

/// (T11) A negative integral spelling inhabits decimal exactly like a
/// positive one.
#[test]
fn t11_negative_integral_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { d:decimal=-1 min=-2 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "negative integral decimal: {diags:?}");
}

/// (T11) No int64 narrowing in decimal positions: a 23-digit integral
/// spelling is a valid decimal (values `decimalFromInteger`).
#[test]
fn t11_big_integral_beyond_i64_accepted() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { d:decimal=12345678901234567890123 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "beyond-i64 integral decimal: {diags:?}");
}

/// (T11) Derived-function arguments accept integral spellings for
/// decimal parameters.
#[test]
fn t11_derive_arg_accepts_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n derive f(d:decimal):decimal = d\nWhen\n scenario s() by=members\n  do\n   let y = f(1)\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "integral derive argument: {diags:?}");
}

/// (T11) Operation `call` inputs accept integral spellings for decimal
/// parameters.
#[test]
fn t11_call_input_accepts_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario calc(d:decimal) by=members\n  do\n   let x = 1\n scenario caller() by=members\n  do\n   call calc {d=1}\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "integral call input: {diags:?}");
}

/// (T11) An int-typed variable never coerces to decimal (the core R16
/// negative).
#[test]
fn t11_int_variable_stays_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { d:decimal }\n policy M read=members\nWhen\n scenario s(n:int) by=members\n  do\n   create M {d=n} as m\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("expected decimal, found int"),
        "{}",
        diags[0].message
    );
}

/// (T11) An int-typed member access never coerces to decimal
/// (CanMember:371 `requested_units=value.quantity` stays).
#[test]
fn t11_member_access_stays_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { n:int }\n N { d:decimal }\n policy M read=members\n policy N read=members\nWhen\n scenario s(m:M) by=members\n  do\n   create N {d=m.n} as x\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("expected decimal, found int"),
        "{}",
        diags[0].message
    );
}

/// (T11) An int-typed call result never coerces to decimal
/// (CanMember:377 `held=max(...)` stays).
#[test]
fn t11_call_result_stays_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { d:decimal }\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   create M {d=count([1])} as m\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("expected decimal, found int"),
        "{}",
        diags[0].message
    );
}

/// Catalog with int/decimal overload twins (transcribed twin shape
/// from the real producer catalog: `abs`).
const ABS_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-b4-abs",
  "entries": [
    {"id": "abs", "js": "abs", "owner": "test", "kind": "builtin", "signature": "abs(value:int)->int; abs(value:decimal)->decimal", "effects": "pure", "availability": "implemented"}
  ]
}"#;

/// (T11) Overload twins are untouched: an integral literal still takes
/// the exact int overload (no ambiguity error, no silent flip to
/// decimal).
#[test]
fn t11_overload_exact_int_wins() {
    let catalog = fixture_with(ABS_JSON);
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\n derive g(n:int):int = n\nWhen\n scenario s() by=members\n  do\n   let y = g(abs(5))\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "exact int overload wins: {diags:?}");
}

/// (T11) An overload result never inhabits decimal: `abs(5)` is int,
/// so a decimal slot still rejects it even though a decimal twin
/// exists.
#[test]
fn t11_overload_result_never_inhabits() {
    let catalog = fixture_with(ABS_JSON);
    let src = "app T\nGiven\n M { d:decimal }\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   create M {d=abs(5)} as m\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("expected decimal, found int"),
        "{}",
        diags[0].message
    );
}

/// (T11) Precision/range control: a 39-digit integral spelling in a
/// decimal position is `E3001`, never silently rounded.
#[test]
fn t11_out_of_range_integral_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { d:decimal=123456789012345678901234567890123456789 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("has 39 significant digits (max 38)"),
        "{}",
        diags[0].message
    );
}

/// (T11) Sibling inference is not adopted: a mixed int/decimal array
/// with no unique expectation stays heterogeneous
/// (CanMember:164/376/377 stay).
#[test]
fn t11_mixed_array_stays_rejected() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { t:text }\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let a = [0,1.5]\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("must have the same type"),
        "{}",
        diags[0].message
    );
}

/// (T11) Bound order still checks on integral decimal bounds.
#[test]
fn t11_min_exceeds_max_still_checked() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { d:decimal min=1 max=0 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3012"], "{diags:?}");
    assert!(
        diags[0].message.contains("min= (1) exceeds max= (0)"),
        "{}",
        diags[0].message
    );
}

/// (T11) The rule is decimal-only: a money bound still rejects an
/// integral spelling.
#[test]
fn t11_money_bound_rejects_integral() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { m:money min=0 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3012"], "{diags:?}");
}

/// (T11) No reverse inhabitation: an int bound still rejects a decimal
/// spelling.
#[test]
fn t11_int_bound_rejects_decimal() {
    let catalog = fixture();
    let src = "app T\nGiven\n M { n:int min=0.5 }\n policy M read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3012"], "{diags:?}");
}

// --- T14a bound-send/request/recipe validation against T13a owner schemas ---
//
// `send` bindings and delivery-recipe `request=` over T13a-known `std`
// operations (EmailV1.send, ErrorsV1.report, PaymentsV1.*) validate
// against the consumed owner schemas: unknown inputs, value
// mismatches and missing required inputs fail with the same codes as
// local operations. Unknown operations of known capabilities are
// wrong associations (verified wrong, never opaque). Unknown members
// keep their opaque treatment; T13b targets validate per the T14b
// section below (T14b lifted the scope gate, superseding the two
// T14a remainder pins).

/// (T14a) A complete `Mail.send` checks clean with `attachments`
/// omitted (B9: default-empty per DESIGN §8 `=[]`; CanApprove:268
/// shape).
#[test]
fn t14a_std_send_mail_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"Review\",body=\"Plan\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "Mail.send bindings: {diags:?}");
}

/// (T14a) Supplied `attachments` must be file-typed (CanDesk:43
/// shape).
#[test]
fn t14a_std_send_mail_with_attachments() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { doc:file }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"Wi-Fi\",body=\"Checking\",attachments=[m.doc]} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "file attachments: {diags:?}");
}

/// (T14a) `Payments.collect` validates money/text inputs with an
/// explicit-null consent (CanInvoice:367 shape).
#[test]
fn t14a_std_send_payments_collect() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {PaymentsV1 as Payments} from=deployment.payments\n Given\n  M { total:money, ref:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Payments.collect {customer=\"c\",amount=m.total,reference=m.ref,consent=null} as delivery\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "collect bindings: {diags:?}");
}

/// (T14a) Nominal-typed values (`event: ErrorReport`) are
/// presence-checked with their shape unchecked: the consumed schema
/// is nominal-only there (CanDo:115 shape).
#[test]
fn t14a_std_send_errors_report_passthrough() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ErrorsV1 as Catch} from=deployment.errors\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Catch.report {event=\"boom\"} as delivery\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "report passthrough: {diags:?}");
}

/// (T14a) A `Mail.send` recipe validates its `request=` against the
/// owner inputs (CanApprove:44 shape).
#[test]
fn t14a_std_recipe_mail_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  fixture attempt=Mail.send {request={to=\"a@b.test\",subject=\"Review\",body=\"Plan\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "Mail.send recipe: {diags:?}");
}

/// (T14a) A failed envelope over a validated recipe stays consistent
/// and claims its bare status case (CanApprove:46 shape: no E2001
/// for `failed`).
#[test]
fn t14a_std_recipe_failed_envelope() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  fixture d=Mail.send {request={to=\"a@b.test\",subject=\"Review\",body=\"Plan\"},status=failed,error={code=\"provider\",message=\"Delivery rejected\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "failed envelope: {diags:?}");
}

/// (T14a) A `Payments.reconcile` recipe validates its single required
/// input (CanInvoice:170 shape).
#[test]
fn t14a_std_recipe_payments_reconcile() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {PaymentsV1 as Payments} from=deployment.payments\n Given\n  fixture r=Payments.reconcile {request={reference=\"r\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "reconcile recipe: {diags:?}");
}

/// (T14a) `delivery()` over a known T13a operation keeps its silent
/// opaque treatment (no new diagnostic).
#[test]
fn t14a_std_delivery_known_silent() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { delivery:delivery(Mail.send)? }\n  policy M read=members fields=delivery.status\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "known delivery(): {diags:?}");
}

/// (T14a) Unknown send bindings fail `E3010` like local operations.
#[test]
fn t14a_std_send_unknown_input() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\",bogus=1} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'Mail.send' has no input 'bogus'"),
        "{}",
        diags[0].message
    );
}

/// (T14a) Missing required send bindings fail `E3010` per input.
#[test]
fn t14a_std_send_missing_required() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010", "E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("missing required input 'subject'"),
        "{}",
        diags[0].message
    );
    assert!(
        diags[1].message.contains("missing required input 'body'"),
        "{}",
        diags[1].message
    );
}

/// (T14a) Mistyped send bindings fail `E3001` like local operations.
#[test]
fn t14a_std_send_type_mismatch() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=42,subject=\"s\",body=\"b\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("'to': expected email, found int"),
        "{}",
        diags[0].message
    );
}

/// (T14a) A `send` to an operation outside the owner schema is a
/// wrong association (`E3010`), verified wrong rather than opaque:
/// no `E3019` follows (`reconcile` is a port op, never source-sent).
#[test]
fn t14a_std_send_wrong_op() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.reconcile {to=\"a@b.test\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'std.EmailV1' has no sendable operation 'reconcile'"),
        "{}",
        diags[0].message
    );
}

/// (T14a) Protected-handle fabrication fails: `attachments` elements
/// must be file-typed, never raw text.
#[test]
fn t14a_std_send_attachments_text_rejected() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\",attachments=[\"x\"]} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("array of file"),
        "{}",
        diags[0].message
    );
}

/// (T14a) Nullable `consent` is a required key with explicit null
/// (producer `consent: string | null`): omission fails `E3010`.
#[test]
fn t14a_std_send_consent_omitted() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {PaymentsV1 as Payments} from=deployment.payments\n Given\n  M { total:money, ref:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Payments.collect {customer=\"c\",amount=m.total,reference=m.ref} as delivery\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("missing required input 'consent'"),
        "{}",
        diags[0].message
    );
}

/// (T14a) Unknown recipe request inputs fail `E3015` like local
/// operation recipes.
#[test]
fn t14a_std_recipe_unknown_input() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  fixture attempt=Mail.send {request={to=\"a@b.test\",subject=\"s\",body=\"b\",bogus=1}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("unknown request input 'bogus' for Mail.send"),
        "{}",
        diags[0].message
    );
}

/// (T14a) Missing required recipe request inputs fail `E3015`.
#[test]
fn t14a_std_recipe_missing_required() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  fixture attempt=Mail.send {request={to=\"a@b.test\",subject=\"s\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("request is missing required input 'body'"),
        "{}",
        diags[0].message
    );
}

/// (T14a) Mistyped recipe request values fail `E3015`.
#[test]
fn t14a_std_recipe_type_mismatch() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  fixture attempt=Mail.send {request={to=42,subject=\"s\",body=\"b\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0].message.contains("'to': expected email, found int"),
        "{}",
        diags[0].message
    );
}

/// (T14a) A recipe over an operation outside the owner schema is a
/// wrong association (`E3015`): no `E3019` follows.
#[test]
fn t14a_std_recipe_wrong_op() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  fixture r=Mail.reconcile {request={to=\"a@b.test\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'std.EmailV1' has no sendable operation 'reconcile'"),
        "{}",
        diags[0].message
    );
}

/// (T14a) A `delivery()` over an operation outside the owner schema
/// is a wrong association (`E3010`).
#[test]
fn t14a_std_delivery_wrong_op() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { delivery:delivery(Mail.reconcile)? }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'std.EmailV1' has no sendable operation 'reconcile'"),
        "{}",
        diags[0].message
    );
}

/// (T14a) Unknown `std` members stay opaque: no schema is guessed.
#[test]
fn t14a_std_unknown_member_stays_e3019() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {Bogus} from=deployment.bogus\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Bogus.op {value=\"hi\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3019"], "{diags:?}");
}

// --- T14b richer bound-send/recipe validation against T13b owner schemas ---
//
// The T14a scope gate is lifted to the full consumed T13 tables:
// TextGenerationV1/LLM, ImagesV1 and MailboxV1/Post sends and recipes
// validate against their owner schemas with the same codes as local
// operations (`E3010`/`E3001` sends, `E3015` recipes); unknown
// operations of known capabilities are wrong associations, verified
// wrong. `std` is compiler-known (B1): unbound known members bind as
// externals so nominal type positions resolve, unknown members are
// `E2004`. Bound nominals normalize to the same binding (B11).
// Remainder: the scoped-out Handbook interface stays `E3019`;
// nominal leaf/field shapes stay unchecked (no T13 leaf tables — a
// T13c-style transcription need, never invented here); cross-target
// delivery-value association needs a `ResolvedType` extension (std
// receipts stay opaque); `on=` handlers bear no `E3019` and are out
// of scope.

/// (T14b) Supersedes the T14a `E3019` remainder pin: an
/// `LLM.generate` send validates, with its nominal `value` passed
/// through presence-checked (consumed schema is nominal-only there).
#[test]
fn t14b_std_send_llm_generate_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send LLM.generate {value=\"hi\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "LLM.generate bindings: {diags:?}");
}

/// (T14b) Supersedes the T14a `E3019` remainder pin: an
/// `LLM.generate` recipe validates its nominal `request=` value.
#[test]
fn t14b_std_recipe_llm_generate_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  fixture r=LLM.generate {request={value=\"hi\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "LLM.generate recipe: {diags:?}");
}

/// (T14b) `LLM.cancel` validates its text/int addressing inputs
/// (CanChat:120 shape).
#[test]
fn t14b_std_send_llm_cancel_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { s:text, n:int }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send LLM.cancel {source=m.s,revision=m.n} as cancellation\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "cancel bindings: {diags:?}");
}

/// (T14b) `Images.inspect` accepts a file-typed graph
/// (CanCreative:68 shape).
#[test]
fn t14b_std_send_images_inspect_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  M { graph:file }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Images.inspect {graph=m.graph} as inspection\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "inspect bindings: {diags:?}");
}

/// (T14b) `Images.submit` passes its nominal request value through
/// (CanCreative:103 shape, simplified).
#[test]
fn t14b_std_send_images_submit_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Images.submit {value=\"req\"} as request\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "submit bindings: {diags:?}");
}

/// (T14b) `Post.reply` passes its nominal reply value through
/// (CanInbox:212 shape, simplified).
#[test]
fn t14b_std_send_post_reply_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {MailboxV1 as Post} from=deployment.inbox\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Post.reply {value=\"req\"} as delivery\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "reply bindings: {diags:?}");
}

/// (T14b) `Post.reconcile` is source-addressed only (CanInbox:227
/// shape): no revision input exists.
#[test]
fn t14b_std_send_post_reconcile_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {MailboxV1 as Post} from=deployment.inbox\n Given\n  M { s:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Post.reconcile {source=m.s} as reconciliation\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "reconcile bindings: {diags:?}");
}

/// (T14b) A `Post.reconcile` recipe validates its source-only
/// `request=` with an unknown envelope (CanInbox:83 shape).
#[test]
fn t14b_std_recipe_post_reconcile_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {MailboxV1 as Post} from=deployment.inbox\n Given\n  fixture check_receipt=Post.reconcile {request={source=\"reply-2\"},status=unknown}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "reconcile recipe: {diags:?}");
}

/// (T14b) An `Images.validate` recipe validates its nominal
/// `request=` value (CanCreative:47 shape, simplified).
#[test]
fn t14b_std_recipe_images_validate_clean() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  fixture checked=Images.validate {request={value=\"def\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "validate recipe: {diags:?}");
}

/// (T14b) `delivery()` over a known T13b operation keeps its silent
/// opaque treatment (cross-target association needs a
/// `ResolvedType` extension, out of scope).
#[test]
fn t14b_std_delivery_t13b_known_silent() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { delivery:delivery(LLM.generate)? }\n  policy M read=members fields=delivery.status\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "known T13b delivery(): {diags:?}");
}

/// (T14b/B1) An unbound `std` nominal import resolves: the field
/// type position is reachable with no `E2005` and no `E2001`.
#[test]
fn t14b_b1_unbound_nominal_type_position() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextRequest}\n Given\n  M { request:TextRequest }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "unbound nominal type: {diags:?}");
}

/// (T14b/B1) Nominal values construct without leaf validation
/// and flow into nominal send inputs silently (no T13 leaf tables
/// exist to check entries against; the entries stay unchecked,
/// never invented).
#[test]
fn t14b_b1_unbound_nominal_construct() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextRequest}\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send LLM.generate {value=TextRequest {source=\"s\"}} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nominal construct: {diags:?}");
}

/// (T14b/B1) A nominal-typed model-fixture flow surfaces `E3015`
/// per the established opaque-mismatch rule (`types_compatible`
/// never unifies `Opaque`; cf. the baseline `derived field:
/// expected {opaque}, found {opaque}` siblings): the checker
/// honestly cannot verify the flow without T13 leaf tables, so it
/// reports instead of blindly accepting. Verification is owed to a
/// T13c-style leaf-table transcription, out of T14b scope.
#[test]
fn t14b_b1_nominal_fixture_flow_surfaces_e3015() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextRequest}\n Given\n  M { request:TextRequest }\n  policy M read=members\n  fixture r=M {request=TextRequest {source=\"s\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'request': expected {opaque}, found {opaque}"),
        "{}",
        diags[0].message
    );
}

/// (T14b/B11) A bound nominal import normalizes to the same binding
/// as the unbound form: `from=` on a value type carries no binding
/// meaning (CanApprove:8 shape).
#[test]
fn t14b_b11_bound_nominal_type_position() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail,DeliveryResult} from=deployment.mail\n Given\n  M { outcome:DeliveryResult }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "bound nominal type: {diags:?}");
}

/// (T14b/B1) The compiler-known rule is uniform: an unbound known
/// capability binds external exactly like the bound form (the
/// `External` binding carries no bound flag; std dispatch binding
/// is a T24 concern, not a T14b gate).
#[test]
fn t14b_b1_unbound_capability_resolves() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail}\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"Review\",body=\"Plan\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "unbound capability send: {diags:?}");
}

/// (T14b) Missing addressing inputs fail `E3010` per input.
#[test]
fn t14b_std_send_llm_cancel_missing_revision() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { s:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send LLM.cancel {source=m.s} as cancellation\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0].message.contains("missing required input 'revision'"),
        "{}",
        diags[0].message
    );
}

/// (T14b) Protected-handle fabrication fails: `graph` must be
/// file-typed, never raw text.
#[test]
fn t14b_std_send_images_inspect_graph_text() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Images.inspect {graph=\"x\"} as inspection\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("'graph': expected file, found text"),
        "{}",
        diags[0].message
    );
}

/// (T14b) Mistyped addressing inputs fail `E3001`.
#[test]
fn t14b_std_send_llm_cancel_revision_text() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { s:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send LLM.cancel {source=m.s,revision=\"x\"} as cancellation\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains("'revision': expected int, found text"),
        "{}",
        diags[0].message
    );
}

/// (T14b) `Post.reconcile` takes no revision: source-only
/// addressing rejects the extra input with `E3010`.
#[test]
fn t14b_std_send_post_reconcile_with_revision() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {MailboxV1 as Post} from=deployment.inbox\n Given\n  M { s:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Post.reconcile {source=m.s,revision=1} as reconciliation\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'Post.reconcile' has no input 'revision'"),
        "{}",
        diags[0].message
    );
}

/// (T14b) A `send` to an operation outside the T13b owner schema is
/// a wrong association (`E3010`): no `E3019` follows.
#[test]
fn t14b_std_send_images_wrong_op() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Images.bogus {value=\"x\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'std.ImagesV1' has no sendable operation 'bogus'"),
        "{}",
        diags[0].message
    );
}

/// (T14b) Unknown recipe request inputs fail `E3015` like local
/// operation recipes.
#[test]
fn t14b_std_recipe_post_reply_unknown_input() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {MailboxV1 as Post} from=deployment.inbox\n Given\n  fixture r=Post.reply {request={value=\"x\",bogus=1}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("unknown request input 'bogus' for Post.reply"),
        "{}",
        diags[0].message
    );
}

/// (T14b) A recipe over an operation outside the T13b owner schema
/// is a wrong association (`E3015`): no `E3019` follows.
#[test]
fn t14b_std_recipe_images_wrong_op() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  fixture r=Images.bogus {request={value=\"x\"}}\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3015"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'std.ImagesV1' has no sendable operation 'bogus'"),
        "{}",
        diags[0].message
    );
}

/// (T14b) A `delivery()` over an operation outside the T13b owner
/// schema is a wrong association (`E3010`).
#[test]
fn t14b_std_delivery_llm_wrong_op() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { delivery:delivery(LLM.bogus)? }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3010"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'std.TextGenerationV1' has no sendable operation 'bogus'"),
        "{}",
        diags[0].message
    );
}

/// (T14b/B1) An unknown member of the known `std` provider is
/// `E2004` (the member is not declared; the provider is).
#[test]
fn t14b_b1_unbound_unknown_member() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {Bogus}\n Given\n  M { t:text }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2004"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("import member 'Bogus' is not declared in 'std'"),
        "{}",
        diags[0].message
    );
}

/// (T14b/B1) Membership is per member: a mixed line binds the known
/// nominal and rejects only the unknown member.
#[test]
fn t14b_b1_mixed_line_binds_known_rejects_unknown() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextRequest,Bogus}\n Given\n  M { request:TextRequest }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2004"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("import member 'Bogus' is not declared in 'std'"),
        "{}",
        diags[0].message
    );
}

/// (T14b/B1) B1 is `std`-only: other unknown providers still fail
/// `E2005` when unbound.
#[test]
fn t14b_b1_nonstd_unbound_provider_stays_e2005() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use bogus {X}\n Given\n  M { t:text }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2005"], "{diags:?}");
}

/// (T14b) The B8 scoped-out Handbook interface keeps `E3019`: no
/// executable schemas exist, so no validation is guessed.
#[test]
fn t14b_handbook_send_stays_e3019() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {Handbook} from=deployment.knowledge\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Handbook.answer {value=\"hi\"} as attempt\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3019"], "{diags:?}");
    assert!(
        diags[0].message.contains("cannot verify send to 'Handbook.answer'"),
        "{}",
        diags[0].message
    );
}

// --- T14c typed external deliveries ---
//
// A `send` to a T13-known `std` operation carries a typed receipt
// (`StdDelivery`): the closed `id`/`status`/`result`/`error` leaves
// resolve, `result` types against the consumed owner result shape
// (opaque while every T13 result name is nominal-only -- a T13c
// transcription need, never guessed), wrong leaves fail `E2013`
// naming the receipt identity, and cross-target associations fail
// (`E3001` assignment, `E3002` comparison). Unknown/unconsumed
// receipt positions (the scoped-out Handbook interface, unknown
// members/providers) stay silently opaque.

/// (T14c) A typed `std` receipt exposes its closed observation
/// leaves: `id`/`status`/`error` reads check clean.
#[test]
fn t14c_std_receipt_known_leaves_accept() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as attempt\n    let i = attempt.id\n    let st = attempt.status\n    let e = attempt.error\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "typed receipt leaves: {diags:?}");
}

/// (T14c) `attempt.result` reads clean against the consumed result
/// shape (opaque while T13 result names are nominal-only) and stays
/// null-tolerant like a local delivery result.
#[test]
fn t14c_std_receipt_result_accepts() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as attempt\n    let r = attempt.result\n    let done = attempt.result == null\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "typed receipt result: {diags:?}");
}

/// (T14c) A leaf outside the closed observation set is a wrong
/// association (`E2013`) naming the receipt identity.
#[test]
fn t14c_std_receipt_wrong_leaf_rejects() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as attempt\n    let x = attempt.bogus\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("unknown member 'bogus' on delivery(std.EmailV1.send)"),
        "{}",
        diags[0].message
    );
}

/// (T14c) Same-target receipts compare: no over-rejection from the
/// new identity.
#[test]
fn t14c_std_receipt_same_target_compares() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as first\n    send Mail.send {to=\"c@d.test\",subject=\"t\",body=\"u\"} as second\n    let same = first == second\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "same-target compare: {diags:?}");
}

/// (T14c) Cross-target receipts never compare (`E3002`): the
/// wrong-association promise for `std` receipts.
#[test]
fn t14c_std_receipt_cross_target_compare_rejects() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n use std {PaymentsV1 as Payments} from=deployment.payments\n Given\n  M { total:money, ref:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as mail\n    send Payments.collect {customer=\"c\",amount=m.total,reference=m.ref,consent=null} as pay\n    let same = mail == pay\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3002"], "{diags:?}");
    assert!(
        diags[0].message.contains(
            "cannot compare delivery(std.EmailV1.send) with delivery(std.PaymentsV1.collect)"
        ),
        "{}",
        diags[0].message
    );
}

/// (T14c) A `delivery(std...)` position rejects a cross-target
/// receipt (`E3001`): declared and send-side identities agree.
#[test]
fn t14c_std_delivery_cross_target_assign_rejects() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n use std {PaymentsV1 as Payments} from=deployment.payments\n Given\n  derive f(a:delivery(Payments.collect)?):delivery(Mail.send)? = a\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0].message.contains(
            "derived function: expected delivery(std.EmailV1.send)?, found delivery(std.PaymentsV1.collect)?"
        ),
        "{}",
        diags[0].message
    );
}

/// (T14c) A `delivery(std...)` position accepts a same-target
/// receipt: no over-rejection from the new identity.
#[test]
fn t14c_std_delivery_same_target_assign_accepts() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  derive g(a:delivery(Mail.send)?):delivery(Mail.send)? = a\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "same-target assign: {diags:?}");
}

/// (T14c) Unconsumed receipt positions stay opaque: a Handbook
/// receipt reads any leaf silently (only its `E3019` fires).
#[test]
fn t14c_std_unknown_receipt_stays_opaque() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {Handbook} from=deployment.knowledge\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Handbook.answer {value=\"hi\"} as attempt\n    let x = attempt.anything\n    let y = attempt.result.deeper\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3019"], "{diags:?}");
}

/// (T14d fixture) The shared `format`/`count` fixture plus the
/// real `first` overload (transcribed from the analysis fixture),
/// for element reads on nominal leaf arrays.
const T14D_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-b4-t14d",
  "entries": [
    {"id": "count", "js": "count", "owner": "test", "kind": "builtin", "signature": "count(domain:C<T>)->int", "effects": "pure", "availability": "implemented"},
    {"id": "format", "js": "format", "owner": "test", "kind": "builtin", "signature": "format(template:text,values:closed object of Display)->text; format(descriptor:message,locale:locale?)->text", "effects": "pure", "availability": "implemented"},
    {"id": "first", "js": "first", "owner": "test", "kind": "builtin", "signature": "first(domain:ordered C<T>)->T?", "effects": "pure", "availability": "implemented"}
  ]
}"#;

fn t14d_fixture() -> Catalog {
    fixture_with(T14D_JSON)
}

/// (T14c) `std` delivery fields obey the same nullable rule as
/// bound-local ones (`E3008`).
#[test]
fn t14c_std_delivery_field_must_be_nullable() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { delivery:delivery(Mail.send) }\n  policy M read=members\n When\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3008"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("delivery fields must be nullable"),
        "{}",
        diags[0].message
    );
}

// --- T14d nominal-leaf checker join ---
//
// `attempt.result` on a typed `std` receipt resolves through the
// committed T13c transcription (`nominal_schema`, DESIGN §8.1
// `result:R?`): the 8 result nominals expose their closed field
// objects, transcribed refinements (`money`, `url?`) and named-ref
// nesting (`GeneratedImage[]`) included. Non-transcribed refs
// (lane-2 `CanDuration`/`DatetimeValue`, nested `WorkflowField`),
// unknown/absent nominals and the scoped-out Handbook interface
// stay silently opaque. Wrong result-leaves are `E2013`; leaves
// never leak across nominals.

/// (T14d) `EmailAccepted.reference` resolves to `text`: safe access
/// feeds a `text?` field, a narrowed read feeds a `text` field.
#[test]
fn t14d_email_accepted_reference() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text, ref:text? }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as attempt\n    set m {ref=attempt.result?.reference}\n    require attempt.result != null\n    set m {t=attempt.result.reference}\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "EmailAccepted leaves: {diags:?}");
}

/// (T14d) `ErrorAccepted.reference` resolves to `text`.
#[test]
fn t14d_error_accepted_reference() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ErrorsV1 as Catch} from=deployment.errors\n Given\n  M { ref:text? }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Catch.report {event=\"boom\"} as attempt\n    set m {ref=attempt.result?.reference}\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "ErrorAccepted leaves: {diags:?}");
}

/// (T14d) `PaymentState` leaves arrive exactly as transcribed: the
/// `money`/`url?` refinements and nullable scalars feed their
/// precisely-typed fields (any other leaf type would be `E3001`).
#[test]
fn t14d_payment_state_refinement() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {PaymentsV1 as Payments} from=deployment.payments\n Given\n  M { total:money, ref:text, amount:money?, link:url?, provider:text?, revision:int? }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Payments.collect {customer=\"c\",amount=m.total,reference=m.ref,consent=null} as attempt\n    set m {amount=attempt.result?.amount,link=attempt.result?.checkout_url,provider=attempt.result?.provider_reference,revision=attempt.result?.revision}\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "PaymentState leaves: {diags:?}");
}

/// (T14d) Transcribed enum leaves claim their bare cases in
/// comparisons, exactly like local enum reads.
#[test]
fn t14d_payment_state_enum_leaf() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {PaymentsV1 as Payments} from=deployment.payments\n Given\n  M { total:money, ref:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Payments.collect {customer=\"c\",amount=m.total,reference=m.ref,consent=null} as attempt\n    require attempt.result?.status == succeeded\n    let pending = attempt.result?.status == null\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "PaymentState enum leaf: {diags:?}");
}

/// (T14d) `TextRun` scalar/enum leaves resolve (`content`,
/// `used_tokens`, `state`).
#[test]
fn t14d_text_run_leaves() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextGenerationV1 as LLM} from=deployment.llm\n Given\n  M { content:text?, used:int? }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send LLM.generate {value=\"hi\"} as attempt\n    set m {content=attempt.result?.content,used=attempt.result?.used_tokens}\n    require attempt.result?.state == running\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "TextRun leaves: {diags:?}");
}

/// (T14d) `WorkflowInspection.fields` is a named-ref array over the
/// NON-transcribed nested `WorkflowField`: the array shape resolves
/// but its elements stay silently opaque (no `E2013` on any member).
#[test]
fn t14d_workflow_inspection_fields_opaque() {
    let catalog = t14d_fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  M { graph:file, n:int }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Images.inspect {graph=m.graph} as attempt\n    require attempt.result != null\n    set m {n=count(attempt.result.fields)}\n    let x = first(attempt.result.fields)?.anything\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "WorkflowInspection fields: {diags:?}");
}

/// (T14d) `WorkflowValidation` scalar leaves resolve (`valid`,
/// `digest`).
#[test]
fn t14d_workflow_validation_leaves() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  M { valid:bool?, digest:text? }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Images.validate {value=\"def\"} as attempt\n    set m {valid=attempt.result?.valid,digest=attempt.result?.digest}\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "WorkflowValidation leaves: {diags:?}");
}

/// (T14d) `ImageRun.outputs` nests the transcribed `GeneratedImage`
/// nominal: element leaves resolve with their declared shapes.
#[test]
fn t14d_image_run_named_ref_nesting() {
    let catalog = t14d_fixture();
    let src = "app T uses=[p]\npackage p\n use std {ImagesV1 as Images} from=deployment.images\n Given\n  M { position:int?, image:file?, charged:int? }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Images.submit {value=\"req\"} as attempt\n    require attempt.result != null\n    set m {position=first(attempt.result.outputs)?.position,image=first(attempt.result.outputs)?.image,charged=attempt.result.charged_jobs}\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "ImageRun nesting: {diags:?}");
}

/// (T14d) `MailReplyOutcome` leaves resolve (`reference`, `state`).
#[test]
fn t14d_mail_reply_outcome_leaves() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {MailboxV1 as Post} from=deployment.inbox\n Given\n  M { ref:text? }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Post.reply {value=\"req\"} as attempt\n    set m {ref=attempt.result?.reference}\n    require attempt.result?.state == accepted\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "MailReplyOutcome leaves: {diags:?}");
}

/// (T14d) A leaf outside the transcribed nominal is a wrong
/// association (`E2013`), in the established T14c message style.
#[test]
fn t14d_wrong_result_leaf_rejects() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as attempt\n    let x = attempt.result?.bogus\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("unknown member 'bogus' on object"),
        "{}",
        diags[0].message
    );
}

/// (T14d) The wrong-leaf rejection also fires on narrowed
/// plain-dot reads (no silent path around the closed set).
#[test]
fn t14d_wrong_leaf_narrowed_rejects() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as attempt\n    require attempt.result != null\n    let x = attempt.result.bogus\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("unknown member 'bogus' on object"),
        "{}",
        diags[0].message
    );
}

/// (T14d) Transcribed leaves do not leak across nominals: a
/// `PaymentState` leaf on `EmailAccepted` and an `ImageRun` leaf
/// on `MailReplyOutcome` both fail.
#[test]
fn t14d_leaves_do_not_leak_across_nominals() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n use std {MailboxV1 as Post} from=deployment.inbox\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as mail\n    send Post.reply {value=\"req\"} as post\n    let x = mail.result?.amount\n    let y = post.result?.outputs\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E2013", "E2013"], "{diags:?}");
}

/// (T14d) The scoped-out Handbook interface stays opaque through
/// the join: safe-access result reads stay silent (only the send
/// `E3019` fires).
#[test]
fn t14d_handbook_result_stays_opaque() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {Handbook} from=deployment.knowledge\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Handbook.answer {value=\"hi\"} as attempt\n    let x = attempt.result?.anything.deeper\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3019"], "{diags:?}");
}

/// (T14d) The transcription never leaks into non-result nominal
/// positions: an external-typed nominal value reads any member
/// silently, exactly as before the join.
#[test]
fn t14d_nominal_value_position_stays_opaque() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {TextRequest}\n Given\n  M { request:TextRequest }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    let x = m.request.source.deeper\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "nominal value position: {diags:?}");
}

/// (T14d) Same-target leaves share the existing compat: two
/// `Mail.send` receipt references compare as `text`.
#[test]
fn t14d_same_target_leaf_compares() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as first\n    send Mail.send {to=\"c@d.test\",subject=\"t\",body=\"u\"} as second\n    require first.result != null and second.result != null\n    let same = first.result.reference == second.result.reference\n Then\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "same-target leaf compare: {diags:?}");
}

/// (T14d) No new coercions: a nullable nominal leaf into a required
/// send input fails under the established rule.
#[test]
fn t14d_nullable_leaf_into_required_input_rejects() {
    let catalog = fixture();
    let src = "app T uses=[p]\npackage p\n use std {EmailV1 as Mail} from=deployment.mail\n Given\n  M { t:text }\n  policy M read=members\n When\n  scenario s(m:M) by=members\n   do\n    send Mail.send {to=\"a@b.test\",subject=\"s\",body=\"b\"} as first\n    send Mail.send {to=first.result?.reference,subject=\"t\",body=\"u\"} as second\n Then\n";
    let diags = check(src, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E3001"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'to': expected email, found text?"),
        "{}",
        diags[0].message
    );
}

// --- T35/R23: imported CRUD sequences resolve to the canonical
// owner's exported operations ------------------------------------------
// Owner contract first: every verdict keys on the owning package's
// `crud` declaration (exported model + enabled op), never on
// call-site spelling. Positives mirror the corpus sites
// (CanMail:143 Contact.update, CanMail:152 Contact.delete,
// CanWorkbench:128 Task.update); negatives pin disabled, absent,
// private and bound boundaries.

/// (T35/R23) CanMail:143 shape: `call Contact.update` on a
/// plain-imported model resolves to the owner's enabled operation and
/// checks fully clean.
#[test]
fn t35r23_imported_update_resolves() {
    let src = "package stock\n Given\n  export Widget { title:text }\n  policy Widget read=members\n  export fixture w=Widget {title=\"a\"}\n When\n  crud Widget by=members fields=title\n Then\npackage shop\n use stock {Widget,w}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[w]\n    do\n     call go {} by=self\n     call Widget.update {record=w,changes={title=\"b\"}} by=self\n     w.title -> \"b\"\n Then\n";
    let diags = check(src, None);
    assert!(
        diags.is_empty(),
        "enabled imported update resolves: {diags:?}"
    );
}

/// (T35/R23) CanMail:152 shape: `call Contact.delete` on a
/// plain-imported model resolves to the owner's enabled operation.
#[test]
fn t35r23_imported_delete_resolves() {
    let src = "package stock\n Given\n  export Widget { title:text }\n  policy Widget read=members\n  export fixture w=Widget {title=\"a\"}\n When\n  crud Widget by=members fields=title\n Then\npackage shop\n use stock {Widget,w}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[w]\n    do\n     call go {} by=self\n     call Widget.delete {record=w} by=self\n     w.title -> \"a\"\n Then\n";
    let diags = check(src, None);
    assert!(
        diags.is_empty(),
        "enabled imported delete resolves: {diags:?}"
    );
}

/// (T35/R23) Same class, third operation: an enabled imported
/// `create` resolves with its required model fields checked.
#[test]
fn t35r23_imported_create_resolves() {
    let src = "package stock\n Given\n  export Widget { title:text }\n  policy Widget read=members\n  export fixture w=Widget {title=\"a\"}\n When\n  crud Widget by=members fields=title\n Then\npackage shop\n use stock {Widget,w}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[w]\n    do\n     call go {} by=self\n     call Widget.create {title=\"b\"} by=self\n     w.title -> \"a\"\n Then\n";
    let diags = check(src, None);
    assert!(
        diags.is_empty(),
        "enabled imported create resolves: {diags:?}"
    );
}

/// (T35/R23) Disabled stays unavailable: the owner declares
/// `update=none`, so the imported `call Gadget.update` still fails
/// `E5006` at the call site.
#[test]
fn t35r23_disabled_update_stays_rejected() {
    let src = "package stock\n Given\n  export Gadget { title:text }\n  policy Gadget read=members\n  export fixture g=Gadget {title=\"a\"}\n When\n  crud Gadget by=members fields=title update=none\n Then\npackage shop\n use stock {Gadget,g}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[g]\n    do\n     call go {} by=self\n     call Gadget.update {record=g,changes={title=\"b\"}} by=self\n     g.title -> \"a\"\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E5006"], "{diags:?}");
    assert!(
        diags[0].message.contains("'Gadget.update' is not enabled"),
        "{}",
        diags[0].message
    );
    let (start, end) = span_of(src, "Gadget.update", 1);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (start, end));
}

/// (T35/R23) Disabled stays unavailable: the owner declares
/// `delete=none` (the mailroom `Delegate` posture), so the imported
/// `call Gadget.delete` still fails `E5006`.
#[test]
fn t35r23_disabled_delete_stays_rejected() {
    let src = "package stock\n Given\n  export Gadget { title:text }\n  policy Gadget read=members\n  export fixture g=Gadget {title=\"a\"}\n When\n  crud Gadget by=members fields=title delete=none\n Then\npackage shop\n use stock {Gadget,g}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[g]\n    do\n     call go {} by=self\n     call Gadget.delete {record=g} by=self\n     g.title -> \"a\"\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E5006"], "{diags:?}");
    assert!(
        diags[0].message.contains("'Gadget.delete' is not enabled"),
        "{}",
        diags[0].message
    );
    let (start, end) = span_of(src, "Gadget.delete", 1);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (start, end));
}

/// (T35/R23) Boundary pin: same call shape, different owner posture.
/// `Open.update` (enabled) resolves while `Shut.update`
/// (`update=none`) fails — the verdict follows the owner contract.
#[test]
fn t35r23_boundary_same_shape_owner_posture() {
    let src = "package stock\n Given\n  export Open { title:text }\n  export Shut { title:text }\n  policy Open read=members\n  policy Shut read=members\n  export fixture o=Open {title=\"a\"}\n  export fixture s=Shut {title=\"a\"}\n When\n  crud Open by=members fields=title\n  crud Shut by=members fields=title update=none\n Then\npackage shop\n use stock {Open,Shut,o,s}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[o,s]\n    do\n     call go {} by=self\n     call Open.update {record=o,changes={title=\"b\"}} by=self\n     call Shut.update {record=s,changes={title=\"b\"}} by=self\n     o.title -> \"b\"\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E5006"], "{diags:?}");
    assert!(
        diags[0].message.contains("'Shut.update' is not enabled"),
        "{}",
        diags[0].message
    );
    let (start, end) = span_of(src, "Shut.update", 1);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (start, end));
}

/// (T35/R23) Private stays unavailable: the model is not exported, so
/// the import fails `E2003` and the call never resolves to an
/// operation (no `E5006`, no silent acceptance).
#[test]
fn t35r23_private_model_stays_unavailable() {
    let src = "package stock\n Given\n  Gadget { title:text }\n  policy Gadget read=members\n  export fixture g=Gadget {title=\"a\"}\n When\n  crud Gadget by=members fields=title\n Then\npackage shop\n use stock {Gadget,g}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[g]\n    do\n     call go {} by=self\n     call Gadget.update {record=g,changes={title=\"b\"}} by=self\n     g.title -> \"a\"\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E2003"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("import member 'Gadget' of 'stock' is not exported"),
        "{}",
        diags[0].message
    );
    let (start, end) = span_of(src, "Gadget", 5);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (start, end));
}

/// (T35/R23) Bound imports are remote (T28 posture): a `from=` import
/// of an enabled model gets no local alias, so the sequence call
/// keeps today's `E5006`.
#[test]
fn t35r23_bound_import_gets_no_alias() {
    let src = "package stock\n Given\n  export Widget { title:text }\n  policy Widget read=members\n  export fixture w=Widget {title=\"a\"}\n When\n  crud Widget by=members fields=title\n Then\npackage shop\n use stock {Widget,w} from=deployment.stock\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[w]\n    do\n     call go {} by=self\n     call Widget.update {record=w,changes={title=\"b\"}} by=self\n     w.title -> \"b\"\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E5006"], "{diags:?}");
    assert!(
        diags[0].message.contains("'Widget.update' is not enabled"),
        "{}",
        diags[0].message
    );
    let (start, end) = span_of(src, "Widget.update", 1);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (start, end));
}

/// (T35/R25) CanEvent:63 shape: select branches hold literal words
/// in the source and the `nl` variant; only the leading argument
/// binds, so the message checks clean (pre-fix: `E3016` on `Event`,
/// `Toegangsbewijs`, `Planning`, `Toegang`, `Wijziging`).
#[test]
fn t35r25_select_literal_bodies_clean() {
    let src = "app T\nGiven\n message notice_title(kind:text) = \"{kind,select,confirmation{Event ticket confirmed}change{Event schedule or venue changed}cancellation{Event admission cancelled}other{Event ticket update}}\"@{nl=\"{kind,select,confirmation{Toegangsbewijs evenement bevestigd}change{Planning of locatie evenement gewijzigd}cancellation{Toegang tot evenement geannuleerd}other{Wijziging toegangsbewijs evenement}}\"}\nWhen\nThen\n";
    let diags = check(src, None);
    assert!(diags.is_empty(), "select literals clean: {diags:?}");
}

/// (T35/R25) Plural with literal bodies, exact `=N` cases and `#`
/// binds only the count parameter.
#[test]
fn t35r25_plural_literal_bodies_clean() {
    let src = "app T\nGiven\n message seats(n:int) = \"{n, plural, =0 {No seats left} one {# seat left} other {# seats left}}\"@{}\nWhen\nThen\n";
    let diags = check(src, None);
    assert!(diags.is_empty(), "plural literals clean: {diags:?}");
}

/// (T35/R25) Nested select-inside-plural resolves every real parameter
/// across branch levels.
#[test]
fn t35r25_nested_select_plural_clean() {
    let src = "app T\nGiven\n message invite(g:text, n:int) = \"{g, select, male {{n, plural, one {he has # task} other {he has # tasks}}} other {they have tasks}}\"@{}\nWhen\nThen\n";
    let diags = check(src, None);
    assert!(diags.is_empty(), "nested select/plural clean: {diags:?}");
}

/// (T35/R25) Simple typed forms (`number`/`date` with styles) keep
/// binding their leading argument.
#[test]
fn t35r25_typed_simple_forms_clean() {
    let src = "app T\nGiven\n message stats(n:int, d:date) = \"{n,number,integer} items on {d,date,short}\"@{}\nWhen\nThen\n";
    let diags = check(src, None);
    assert!(diags.is_empty(), "typed simple forms clean: {diags:?}");
}

/// (T35/R25) Opposing, both ways: a genuinely unknown top-level
/// placeholder still fails `E3016`.
#[test]
fn t35r25_unknown_top_level_still_rejected() {
    let src = "app T\nGiven\n message t(kind:text) = \"{kind} {bogus}\"@{}\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'{bogus}' names no message parameter"),
        "{}",
        diags[0].message
    );
}

/// (T35/R25) Opposing, both ways: an unknown placeholder nested inside
/// a select branch body still fails `E3016` (branch-aware parsing must
/// not swallow nested references).
#[test]
fn t35r25_unknown_nested_in_branch_still_rejected() {
    let src = "app T\nGiven\n message t(kind:text) = \"{kind,select,confirmation{Event {bogus} confirmed}other{Event update}}\"@{}\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'{bogus}' names no message parameter"),
        "{}",
        diags[0].message
    );
}

/// (T35/R25) Opposing, both ways: an unknown select argument itself
/// still fails `E3016`.
#[test]
fn t35r25_unknown_selector_arg_still_rejected() {
    let src = "app T\nGiven\n message t(kind:text) = \"{bogus,select,other{Event update}}\"@{}\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'{bogus}' names no message parameter"),
        "{}",
        diags[0].message
    );
}

/// (T35/R25) Opposing, both ways: an unknown placeholder in a locale
/// variant still fails `E3016`.
#[test]
fn t35r25_unknown_in_variant_still_rejected() {
    let src =
        "app T\nGiven\n message t(kind:text) = \"{kind}\"@{nl=\"{kind} {bogus}\"}\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E3016"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'{bogus}' names no message parameter"),
        "{}",
        diags[0].message
    );
}

/// (T35/R25) Opposing, both ways: a structurally malformed complex
/// head fails `E5007` at the profile stage (examples.rs, untouched)
/// while the slot scan falls back to the flat scan, so the unknown
/// name inside still fails `E3016` too.
#[test]
fn t35r25_malformed_head_fallback_still_rejected() {
    let src = "app T\nGiven\n message t(kind:text) = \"{kind,select,confirmation Event {bogus}}\"@{}\nWhen\nThen\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E3016", "E5007"], "{diags:?}");
    assert!(
        diags[0]
            .message
            .contains("'{bogus}' names no message parameter"),
        "{}",
        diags[0].message
    );
    assert!(
        diags[1].message.contains("expected '{' to open the branch"),
        "{}",
        diags[1].message
    );
}

/// (T35/R23) Absent stays unavailable: an exported model with no
/// `crud` declaration at all offers no operations to import.
#[test]
fn t35r23_no_crud_declaration_stays_rejected() {
    let src = "package stock\n Given\n  export Bare { title:text }\n  policy Bare read=members\n  export fixture b=Bare {title=\"a\"}\n When\n  scenario idle() by=members\n   do\n    let x = 1\n Then\npackage shop\n use stock {Bare,b}\n Given\n When\n  scenario go() by=members\n   do\n    let x = 1\n   examples seed=[b]\n    do\n     call go {} by=self\n     call Bare.update {record=b,changes={title=\"b\"}} by=self\n     b.title -> \"a\"\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E5006"], "{diags:?}");
    assert!(
        diags[0].message.contains("'Bare.update' is not enabled"),
        "{}",
        diags[0].message
    );
    let (start, end) = span_of(src, "Bare.update", 1);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (start, end));
}

// --- T29 imported containment (T28-A plain_import_containment) ----------------
//
// `Child in ImportedParent` through a plain import carries exactly the
// local-containment semantics (ChildOf linkage, protected `parent`
// binding, parent-scoped behavior); bound (`from=`) and external
// parents stay rejected with E2008, and containment cycles are
// detected over the whole-app index.

/// Canonical containing parent of a model, when linked.
fn child_of(program: &CheckedProgram, child: &str) -> Option<String> {
    let symbol = program.symbols.iter().find(|s| s.canonical == child)?;
    match &symbol.kind {
        SymbolKind::Model {
            owner: ModelOwner::ChildOf(parent),
            ..
        } => Some(program.symbols[parent.0 as usize].canonical.clone()),
        _ => None,
    }
}

/// (T29) A plain-imported stored model contains exactly like a local
/// one: zero E2008 and a ChildOf link to the owner's model.
#[test]
fn t29_plain_imported_parent_accepted() {
    let src = "package employee\n Given\n  export Employee { name:text }\n  policy Employee read=members\n When\n Then\npackage expense\n use employee {Employee}\n Given\n  Expense in Employee { amount:int }\n  policy Expense read=members\n When\n Then\n";
    let (program, diags) = check_full(src);
    assert!(
        diags.iter().all(|d| d.code != "E2008"),
        "plain-imported parent must not draw E2008: {diags:?}"
    );
    assert_eq!(
        child_of(&program, "expense.Expense").as_deref(),
        Some("employee.Employee")
    );
}

/// (T29) Bound (`from=`) parents stay rejected as containment
/// targets: remote packages take a reference field instead.
#[test]
fn t29_bound_parent_rejected() {
    let src = "package employee\n Given\n  export Employee { name:text }\n  policy Employee read=members\n When\n Then\npackage expense\n use employee {Employee} from=deployment.prod\n Given\n  Expense in Employee { amount:int }\n  policy Expense read=members\n When\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E2008"], "{diags:?}");
    assert!(
        diags[0].message.contains("bound (from=)"),
        "{}",
        diags[0].message
    );
}

/// (T29) External (unknown-provider) parents stay rejected.
#[test]
fn t29_external_parent_rejected() {
    let src = "package expense\n use nowhere {Widget} from=deployment.prod\n Given\n  Gadget in Widget { amount:int }\n  policy Gadget read=members\n When\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E2008"], "{diags:?}");
    assert!(
        diags[0].message.contains("is external"),
        "{}",
        diags[0].message
    );
}

/// (T29) A plain-imported non-model is not a stored container.
#[test]
fn t29_imported_non_model_rejected() {
    let src = "package employee\n Given\n  export Employee { name:text }\n  export event Hired { employee:Employee }\n  policy Employee read=members\n When\n Then\npackage expense\n use employee {Employee,Hired}\n Given\n  Expense in Hired { amount:int }\n  policy Expense read=members\n When\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E2008"], "{diags:?}");
    assert!(
        diags[0].message.contains("not a stored model"),
        "{}",
        diags[0].message
    );
}

/// (T29) Containment cycles are detected across packages, same as
/// local cycles.
#[test]
fn t29_cross_package_cycle_rejected() {
    let src = "package a\n use b {Y}\n Given\n  export X in Y { amount:int }\n  policy X read=members\n When\n Then\npackage b\n use a {X}\n Given\n  export Y in X { amount:int }\n  policy Y read=members\n When\n Then\n";
    let diags = check(src, None);
    assert_eq!(codes(&diags), vec!["E2008", "E2008"], "{diags:?}");
    assert!(
        diags
            .iter()
            .all(|d| d.message.contains("containment cycle")),
        "{diags:?}"
    );
}

/// (T29) The imported link behaves like containment downstream: a
/// create without the protected `parent` binding fails.
#[test]
fn t29_imported_child_create_requires_parent() {
    let src = "package employee\n Given\n  export Employee { name:text }\n  policy Employee read=members\n When\n Then\npackage expense\n use employee {Employee}\n Given\n  Expense in Employee { amount:int }\n  policy Expense read=members\n When\n  scenario file() by=members\n   do\n    create Expense {amount=1} as e\n Then\n";
    let diags = check(src, None);
    assert!(
        diags.iter().any(|d| d.message.contains("'parent'")),
        "create without parent must fail naming parent: {diags:?}"
    );
}

// --- A3 boundary proofs: page titles + order keys ----------------------------

/// (A3 P1) A page with a static `title=` checks clean.
#[test]
fn a3_page_title_present_clean() {
    let src = "app T\nGiven\n Meeting { title:text }\n Amendment { text:text }\n policy Meeting read=members\n policy Amendment read=members\nWhen\nThen\n page /t title=\"T\"\n  list Meeting\n   timeline Amendment\n    slot item\n     text row.text\n";
    let diags = check(src, Some(&fixture()));
    assert!(diags.is_empty(), "{diags:?}");
}

/// (A3 P1) A page without `title=` is `E1204` at parse: the parser
/// requires the attribute, so the checker's `E3001` "page needs title="
/// arm is parser-shadowed (kept as defense in depth).
#[test]
fn a3_page_title_missing_e1204() {
    let src = "app T\nGiven\n Meeting { title:text }\n Amendment { text:text }\n policy Meeting read=members\n policy Amendment read=members\nWhen\nThen\n page /t\n  list Meeting\n   timeline Amendment\n    slot item\n     text row.text\n";
    let diags = check(src, Some(&fixture()));
    assert_eq!(codes(&diags), vec!["E1204"], "{diags:?}");
    assert!(
        diags[0].message.contains("missing required attribute"),
        "{}",
        diags[0].message
    );
}

/// (A3 P3) An order key over an ordered scalar checks clean.
#[test]
fn a3_order_key_ordered_clean() {
    let src = "app T\nGiven\n M { active:bool, n:int }\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let x = count(M as m where m.active order=m.n select m)\nThen\n";
    let diags = check(src, Some(&fixture()));
    assert!(diags.is_empty(), "{diags:?}");
}

/// (A3 P3) An order key over a non-ordered scalar is `E3006`.
#[test]
fn a3_order_key_unordered_e3006() {
    let src = "app T\nGiven\n M { active:bool, n:int }\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let x = count(M as m where m.active order=m.active select m)\nThen\n";
    let diags = check(src, Some(&fixture()));
    assert_eq!(codes(&diags), vec!["E3006"], "{diags:?}");
    assert!(
        diags[0].message.contains("must be ordered scalars"),
        "{}",
        diags[0].message
    );
}

/// (A3 P3) A nullable datetime order key checks clean (unwrap + ordered).
#[test]
fn a3_order_key_nullable_datetime_clean() {
    let src = "app T\nGiven\n M { active:bool, due:datetime? }\n policy M read=members\nWhen\n scenario s() by=members\n  do\n   let x = count(M as m where m.active order=m.due select m)\nThen\n";
    let diags = check(src, Some(&fixture()));
    assert!(diags.is_empty(), "{diags:?}");
}
