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
#[test]
fn t08_user_id_member() {
    let catalog = fixture();
    let src =
        "app T\nGiven\n M { owner:user }\n policy M read=members fields=owner.id\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert!(diags.is_empty(), "user.id leaf: {diags:?}");
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
