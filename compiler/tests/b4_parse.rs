//! B4-F1 parser regression tests.
//!
//! * `each=` fan-out on trusted scenarios keeps its `E1203` proposal
//!   marker but must still parse, so the enclosing package stays in the
//!   module index and its body is checked (CanShift/CanVolunteer
//!   each-poisoning).
//! * `delivery(...)`/`invocation(...)` type positions, `expose=` on crud,
//!   page `refresh=` and form `import=csv`/`review=` must parse (B4
//!   coverage NONE rows, already implemented in the Rust parser).
//!
//! D02a: field/parameter `desc=` compact descriptions (source string +
//! optional keyed variants, or a static message path). Duplicate
//! descriptions (`#` + `desc=` + legacy `@{desc}` in any combination),
//! dynamic values, call arguments and record-query tails are rejected
//! with located diagnostics.

use canlang_compiler::analysis::{resolve, types};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, SourceId};
use canlang_compiler::syntax::{self, SyntaxKind, SyntaxNode};

fn file() -> SourceId {
    SourceId(0)
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

fn has_code(diags: &[Diagnostic], code: &str) -> bool {
    diags.iter().any(|d| d.code == code)
}

fn count_kind(node: &SyntaxNode, kind: SyntaxKind) -> usize {
    node.descendants().filter(|n| n.kind == kind).count()
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
            None => panic!("needle {needle:?} occurrence {occurrence} missing"),
        }
    }
    (idx as u32, (idx + needle.len()) as u32)
}

/// Catalog-free check pipeline: parse + resolve + types.
fn check_all(src: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (tree, mut diags) = syntax::parse(&db, id);
    let trees = vec![(id, tree)];
    let resolve_tables = resolve::resolve_program(&db, &trees, None, &mut diags);
    let type_table = types::check_types(&db, &trees, None, &resolve_tables, &mut diags);
    resolve::emit_unresolved(&db, &resolve_tables, &type_table, &mut diags);
    diags
}

const EACH_SRC: &str = "app Probe uses=[probe]

package probe
 Given
  Member { name:text }
  event Ticked { n:int }
 When
  scenario fanout on=Ticked each=Member as member
   require no_such_guard
   do emit Ticked {n=1}
 Then
  page /members title=\"Members\"
   list Members columns=name
";

/// `each=` keeps exactly one `E1203` on the `each` word (proposal
/// marker stays) while the scenario still parses: no `Error` node.
#[test]
fn each_keeps_e1203_without_error_node() {
    let (tree, diags) = syntax::parse_source(file(), EACH_SRC);
    assert_eq!(codes(&diags), vec!["E1203"], "diags: {diags:?}");
    assert_eq!(diags[0].message, "unsupported scenario attribute `each`");
    let (start, _) = span_of(EACH_SRC, "each=Member", 1);
    assert_eq!(diags[0].primary.start, start);
    assert_eq!(diags[0].primary.end, start + "each".len() as u32);
    assert_eq!(count_kind(&tree, SyntaxKind::Error), 0);
    assert_eq!(count_kind(&tree, SyntaxKind::Scenario), 1);
    assert!(tree.verify_coverage(EACH_SRC.len() as u32).is_ok());
}

/// The package enclosing an `each=` scenario stays indexed (no E2005
/// self-drop) and its body is checked (the guard's unknown name
/// surfaces as E2001).
#[test]
fn each_package_body_still_checked() {
    let diags = check_all(EACH_SRC);
    assert!(
        !diags
            .iter()
            .any(|d| d.code == "E2005" && d.message.contains("selects unknown member 'probe'")),
        "package must stay indexed, got {diags:?}"
    );
    assert!(
        diags
            .iter()
            .any(|d| d.code == "E2001" && d.message.contains("no_such_guard")),
        "body must be checked, got {diags:?}"
    );
    assert!(has_code(&diags, "E1203"), "E1203 stays, got {diags:?}");
}

/// Dotted `event`-rooted `each=` source (CanVolunteer:178 shape) parses
/// the same way: one `E1203`, no `Error` node.
#[test]
fn each_event_path_parses() {
    let src = "app Probe uses=[probe]

package probe
 Given
  Member { name:text }
  event Cancelled { n:int }
 When
  scenario cancel_signup on=Cancelled each=event.opportunity.Member as member
   do emit Cancelled {n=1}
 Then
  page /members title=\"Members\"
   list Members columns=name
";
    let (tree, diags) = syntax::parse_source(file(), src);
    assert_eq!(codes(&diags), vec!["E1203"], "diags: {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::Error), 0);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
    let full = check_all(src);
    assert!(
        !full
            .iter()
            .any(|d| d.code == "E2005" && d.message.contains("selects unknown member")),
        "package must stay indexed, got {full:?}"
    );
}

/// `delivery(...)`/`invocation(...)` parse in every type position:
/// model fields, contract fields, scenario params and results.
#[test]
fn delivery_invocation_type_positions_parse() {
    let src = "app Probe uses=[probe]

package probe
 Given
  Job { title:text }
  Box { job:delivery(Mail.send)?, call:invocation(Task.update,complete)? }
  export contract Bag { item:delivery(Mail.send), run:invocation(Task.update)? }
 When
  scenario ping(job:delivery(Mail.send)) by=organizer -> delivery(Mail.send)
   do return job
 Then
  page /jobs title=\"Jobs\"
   list Jobs columns=title
";
    let (tree, diags) = syntax::parse_source(file(), src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert!(count_kind(&tree, SyntaxKind::DeliveryType) >= 4);
    assert!(count_kind(&tree, SyntaxKind::InvocationType) >= 2);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
    let full = check_all(src);
    assert!(
        full.iter().all(|d| !d.code.starts_with("E1")),
        "no syntax errors, got {full:?}"
    );
}

/// `expose=` on crud parses; a valid operation passes, an unknown one
/// fails semantically (E3009) rather than syntactically.
///
/// NOTE (fixed by the MCP P4 lane): multi-value `expose=create,update`
/// used to report E3009 on the comma separator (`check_crud_expose` in
/// analysis/types.rs had no skip arm for separator leaves, unlike
/// `check_selectors`). Both arities are pinned here now.
#[test]
fn crud_expose_parses() {
    let head = "app Probe uses=[probe]

package probe
 Given
  Job { title:text }
 When
";
    let tail = "  scenario ping(x:text) by=organizer
   do emit Pong {x=1}
 Then
  page /jobs title=\"Jobs\"
   list Jobs columns=title
";
    let src = format!("{head}  crud Job by=organizer fields=title expose=create\n{tail}");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
    let full = check_all(&src);
    assert!(
        full.iter().all(|d| !d.code.starts_with("E1")),
        "no syntax errors, got {full:?}"
    );
    assert!(!has_code(&full, "E3009"), "valid expose, got {full:?}");

    let multi = format!("{head}  crud Job by=organizer fields=title expose=create,update\n{tail}");
    let (multi_tree, multi_diags) = syntax::parse_source(file(), &multi);
    assert!(
        multi_diags.is_empty(),
        "expected clean parse, got {multi_diags:?}"
    );
    assert!(multi_tree.verify_coverage(multi.len() as u32).is_ok());
    let multi_full = check_all(&multi);
    assert!(
        !has_code(&multi_full, "E3009"),
        "multi-value allowlist passes, got {multi_full:?}"
    );

    let bad = format!("{head}  crud Job by=organizer fields=title expose=bogus\n{tail}");
    let (_, bad_diags) = syntax::parse_source(file(), &bad);
    assert!(
        bad_diags.is_empty(),
        "expose value parses, got {bad_diags:?}"
    );
    let bad_full = check_all(&bad);
    assert!(
        has_code(&bad_full, "E3009"),
        "unknown operation is E3009, got {bad_full:?}"
    );
}

/// Page `refresh=` parses and resolves as a path.
#[test]
fn page_refresh_parses() {
    let src = "app Probe uses=[probe]

package probe
 Given
  Job { title:text }
 When
  scenario ping(x:text) by=organizer
   do emit Pong {x=1}
 Then
  page /jobs title=\"Jobs\" refresh=jobs_tick poll=5s
   list Jobs columns=title
";
    let (tree, diags) = syntax::parse_source(file(), src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
    let full = check_all(src);
    assert!(
        full.iter().all(|d| !d.code.starts_with("E1")),
        "no syntax errors, got {full:?}"
    );
    assert!(
        full.iter()
            .any(|d| d.code == "E2001" && d.message.contains("jobs_tick")),
        "refresh target resolves, got {full:?}"
    );
}

/// Form `import=csv`/`review=` parse; `review=` resolves as a path.
#[test]
fn form_import_review_parse() {
    let src = "app Probe uses=[probe]

package probe
 Given
  Job { title:text }
 When
  scenario ping(x:text) by=organizer
   do emit Pong {x=1}
 Then
  page /new title=\"New\"
   form Job.create import=csv review=dup_check fields=title
";
    let (tree, diags) = syntax::parse_source(file(), src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
    let full = check_all(src);
    assert!(
        full.iter().all(|d| !d.code.starts_with("E1")),
        "no syntax errors, got {full:?}"
    );
    assert!(
        full.iter()
            .any(|d| d.code == "E2001" && d.message.contains("dup_check")),
        "review target resolves, got {full:?}"
    );
}

// D02a: `desc=` inline descriptions (parser slice) -----------------------------

/// Minimal complete source with one model field under test.
fn desc_field_src(field: &str) -> String {
    format!(
        "app Shop\nGiven\n Gadget {{ {field} }}\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title\nThen\n page / title=\"Shop\"\n  breadcrumbs\n"
    )
}

/// Minimal complete source with scenario parameters under test.
fn desc_param_src(params: &str) -> String {
    format!(
        "app Shop\nGiven\n Gadget {{ title:text }}\n policy Gadget read=members\nWhen\n scenario approve({params}) by=members\n  do set gadget {{title=\"x\"}}\nThen\n page / title=\"Shop\"\n  breadcrumbs\n"
    )
}

/// Value-node kinds inside each `DescriptionValue`, in document order.
fn desc_value_kinds(tree: &SyntaxNode) -> Vec<SyntaxKind> {
    tree.descendants()
        .filter(|n| n.kind == SyntaxKind::DescriptionValue)
        .map(|n| {
            n.children
                .last()
                .map(|c| c.kind)
                .unwrap_or(SyntaxKind::Error)
        })
        .collect()
}

/// Plain-string `desc=` parses on a field and on a parameter; the value
/// stays a bare literal (no message wrapper without a suffix).
#[test]
fn desc_plain_string_on_field_and_param() {
    let src = desc_field_src("title:text desc=\"Display title.\"");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::DescriptionValue), 1);
    assert_eq!(desc_value_kinds(&tree), vec![SyntaxKind::Literal]);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());

    let src = desc_param_src("note:text desc=\"Optional note.\"");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::DescriptionValue), 1);
    assert_eq!(desc_value_kinds(&tree), vec![SyntaxKind::Literal]);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// `desc=` with a `@{...}` suffix reuses message-variant parsing:
/// keyed string/null variants fold into one `MessageValue`.
#[test]
fn desc_with_variants() {
    let src = desc_field_src(
        "name:text desc=\"The name shown to customers.\"@{nl=\"De naam die klanten zien.\", fr=null}",
    );
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::DescriptionValue), 1);
    assert_eq!(desc_value_kinds(&tree), vec![SyntaxKind::MessageValue]);
    assert_eq!(count_kind(&tree, SyntaxKind::MessageVariant), 2);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// `desc=` accepts a static message path (zero-parameter shape is
/// checked semantically; the parser keeps the path node).
#[test]
fn desc_message_path() {
    let src = desc_field_src("title:text desc=Shop.labels.title");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::DescriptionValue), 1);
    assert_eq!(desc_value_kinds(&tree), vec![SyntaxKind::Path]);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// `desc=` delimits correctly against defaults, bounds and labels on
/// both fields and parameters.
#[test]
fn desc_delimits_default_bounds_label() {
    let src = desc_field_src(
        "stock:int=0 desc=\"Units on hand.\", count:int min=1 max=9 desc=\"Bounded count.\", title:text desc=\"Display title.\" label=\"Title\"",
    );
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::DescriptionValue), 3);
    // All three fields survive with their tails (scalar labels are
    // bare captions, so there is no `Label` wrapper to count).
    assert_eq!(count_kind(&tree, SyntaxKind::Field), 3);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());

    let src = desc_param_src("n:int=3 desc=\"Count.\"");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::DescriptionValue), 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// The legacy `@{desc="..."}` spelling still parses alone (locale keys
/// inside stay invalid, pinned by `mcp_p4::desc_unknown_key_rejected`).
#[test]
fn desc_legacy_annotation_still_parses() {
    let src = desc_field_src("title:text @{desc=\"x\"}");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert!(diags.is_empty(), "expected clean parse, got {diags:?}");
    assert_eq!(count_kind(&tree, SyntaxKind::Annotation), 1);
    assert_eq!(count_kind(&tree, SyntaxKind::DescriptionValue), 0);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// Attached `#` plus `desc=` is a duplicate description, located at
/// the `desc` word.
#[test]
fn desc_hash_plus_compact_rejected() {
    let src = "app Shop\nGiven\n Gadget {\n  # Display title.\n  title:text desc=\"x\"\n }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (tree, diags) = syntax::parse_source(file(), src);
    assert_eq!(codes(&diags), vec!["E1202"], "diags: {diags:?}");
    assert!(
        diags[0].message.contains("duplicate"),
        "{}",
        diags[0].message
    );
    let (start, _) = span_of(src, "desc=", 1);
    assert_eq!(diags[0].primary.start, start);
    assert_eq!(diags[0].primary.end, start + "desc".len() as u32);
    assert!(count_kind(&tree, SyntaxKind::Error) >= 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// Attached `#` plus the legacy annotation is a duplicate
/// description, located at the `@` marker.
#[test]
fn desc_hash_plus_legacy_rejected() {
    let src = "app Shop\nGiven\n Gadget {\n  # Display title.\n  title:text @{desc=\"x\"}\n }\n policy Gadget read=members\nWhen\n crud Gadget by=members fields=title\nThen\n page / title=\"Shop\"\n  breadcrumbs\n";
    let (tree, diags) = syntax::parse_source(file(), src);
    assert_eq!(codes(&diags), vec!["E1202"], "diags: {diags:?}");
    assert!(
        diags[0].message.contains("duplicate"),
        "{}",
        diags[0].message
    );
    let (start, _) = span_of(src, "@{", 1);
    assert_eq!(diags[0].primary.start, start);
    assert_eq!(diags[0].primary.end, start + 1);
    assert!(count_kind(&tree, SyntaxKind::Error) >= 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// `desc=` plus the legacy annotation on one declaration is a
/// duplicate description, located at the `@` marker.
#[test]
fn desc_compact_plus_legacy_rejected() {
    let src = desc_field_src("title:text desc=\"x\" @{desc=\"y\"}");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert_eq!(codes(&diags), vec!["E1202"], "diags: {diags:?}");
    assert!(
        diags[0].message.contains("duplicate"),
        "{}",
        diags[0].message
    );
    let (start, _) = span_of(&src, "@{", 1);
    assert_eq!(diags[0].primary.start, start);
    assert_eq!(diags[0].primary.end, start + 1);
    assert!(count_kind(&tree, SyntaxKind::Error) >= 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// A second `desc=` on one declaration is a duplicate description,
/// located at the second `desc` word.
#[test]
fn desc_duplicate_compact_rejected() {
    let src = desc_field_src("title:text desc=\"a\" desc=\"b\"");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert_eq!(codes(&diags), vec!["E1202"], "diags: {diags:?}");
    let (start, _) = span_of(&src, "desc=", 2);
    assert_eq!(diags[0].primary.start, start);
    assert_eq!(diags[0].primary.end, start + "desc".len() as u32);
    assert!(count_kind(&tree, SyntaxKind::Error) >= 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// Dynamic `desc=` values are rejected, located at the value.
#[test]
fn desc_dynamic_rejected() {
    let src = desc_field_src("title:text desc=42");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert_eq!(codes(&diags), vec!["E1214"], "diags: {diags:?}");
    let (start, end) = span_of(&src, "42", 1);
    assert_eq!(diags[0].primary.start, start);
    assert_eq!(diags[0].primary.end, end);
    assert!(count_kind(&tree, SyntaxKind::Error) >= 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// Parameterized `desc=` references are rejected, located at the
/// opening parenthesis.
#[test]
fn desc_parameterized_rejected() {
    let src = desc_field_src("title:text desc=Shop.labels.title(x)");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert_eq!(codes(&diags), vec!["E1214"], "diags: {diags:?}");
    assert!(
        diags[0].message.contains("parameterized"),
        "{}",
        diags[0].message
    );
    let (start, _) = span_of(&src, "(x)", 1);
    assert_eq!(diags[0].primary.start, start);
    assert!(count_kind(&tree, SyntaxKind::Error) >= 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// Record-query `desc=` values are rejected, located at the query
/// clause word.
#[test]
fn desc_record_query_rejected() {
    let src = desc_field_src("title:text desc=Member where active");
    let (tree, diags) = syntax::parse_source(file(), &src);
    assert_eq!(codes(&diags), vec!["E1214"], "diags: {diags:?}");
    assert!(
        diags[0].message.contains("record queries"),
        "{}",
        diags[0].message
    );
    let (start, end) = span_of(&src, "where", 1);
    assert_eq!(diags[0].primary.start, start);
    assert_eq!(diags[0].primary.end, end);
    assert!(count_kind(&tree, SyntaxKind::Error) >= 1);
    assert!(tree.verify_coverage(src.len() as u32).is_ok());
}

/// A duplicate locale inside the `desc=` suffix is rejected by the
/// reused message-suffix parsing.
#[test]
fn desc_variant_duplicate_rejected() {
    let src = desc_field_src("title:text desc=\"a\"@{nl=\"x\", nl=\"y\"}");
    let (_tree, diags) = syntax::parse_source(file(), &src);
    assert_eq!(codes(&diags), vec!["E1214"], "diags: {diags:?}");
    assert!(
        diags[0].message.contains("duplicate"),
        "{}",
        diags[0].message
    );
}
