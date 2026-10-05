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
