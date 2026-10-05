//! B4/F2 resolve-pass regression tests: judgment registration (G3/G4),
//! failed-handler `event` scope (event-in-`for`), and a `set x.parent`
//! characterization pin.
//!
//! Failing-first: the judgment and handler-scope tests fail before the
//! fix (unresolved `E2001`/`E2004`) and pass after. The `set x.parent`
//! test pins CURRENT behavior (a types-pass gap, not fixed here); flip
//! its expectation when the types pass mirrors parent navigation.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::resolve::{self, ResolveTables};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::syntax;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "can-b4-resolve-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Minimal catalog carrying only the `trim` builtin (shape transcribed
/// from the shared analysis fixture): enough to close the `trim` name
/// for the builtin-scenario test.
const TRIM_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-b4",
  "entries": [
    {"id": "trim", "js": "trim", "owner": "test", "kind": "builtin", "signature": "trim(value:S)->text", "effects": "pure", "availability": "implemented"}
  ]
}"#;

fn trim_catalog() -> Catalog {
    let dir = scratch_dir();
    let path = dir.join("catalog.json");
    std::fs::write(&path, TRIM_JSON).unwrap();
    let mut db = SourceDb::new();
    let id = db.add("dummy.can".to_string(), String::new());
    let request = CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(id, 0, 0),
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "{diags:?}");
    catalog.expect("trim catalog")
}

/// Check one source, returning sorted diagnostics.
fn check(src: &str, catalog: Option<&Catalog>) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (_program, mut diags) = check_program(&db, &[id], catalog);
    diags.sort_by(|a, b| {
        (a.primary.start, a.primary.end, &a.code).cmp(&(b.primary.start, b.primary.end, &b.code))
    });
    diags
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

/// Assert exact `(code, start, end)` findings; `expected` entries are
/// `(code, span needle, needle occurrence)`.
#[track_caller]
fn assert_findings(src: &str, diags: &[Diagnostic], expected: &[(&str, &str, usize)]) {
    let mut want: Vec<(String, u32, u32)> = expected
        .iter()
        .map(|(code, needle, occ)| {
            let (start, end) = span_of(src, needle, *occ);
            ((*code).to_string(), start, end)
        })
        .collect();
    want.sort();
    let mut got: Vec<(String, u32, u32)> = diags
        .iter()
        .map(|d| (d.code.to_string(), d.primary.start, d.primary.end))
        .collect();
    got.sort();
    assert_eq!(got, want, "source:\n{src}\nall diagnostics: {diags:?}");
}

/// A local `export judgment` resolves in its own package: the bound
/// self-import (DESIGN §8.2, like capabilities), bare and path type
/// uses, value uses, `send`, `delivery()` and fixture heads. The
/// derived evaluate/result interface stays opaque (DESIGN:897), so no
/// member is checked — names resolve, shapes wait for typing.
#[test]
fn judgment_registers_and_self_import_resolves() {
    let src = r#"package p
 use p {Triage as Judge} from=deployment.judgment
 Given
  export judgment Triage version=1
   route choice "Which queue owns it?" {sales="Sales work",support="Support work"}
   urgency score "How urgent?" [routine="Routine",today="Today"]
  M {note:text,result:Triage?}
  N {kind:Triage.route.choice}
  Holder {request:delivery(Judge.evaluate)?}
  policy M read=members
  policy N read=members
  policy Holder read=members
  fixture judged=Judge.evaluate {request={state="hello"}}
 When
  scenario decide(m:M) by=members
   do
    let spec=Triage.specification
    let revision=Triage.specification.revision
    let frozen=Triage.specification({pick=["a"]})
    send Judge.evaluate {state="hello"} as request
 Then
"#;
    let diags = check(src, None);
    assert_findings(src, &diags, &[]);
}

/// Duplicate judgments collide in the shared package scope.
#[test]
fn judgment_duplicate_is_e2002() {
    let src = r#"package p
 Given
  judgment Triage version=1
   route choice "Pick." {a="A"}
  judgment Triage version=1
   route choice "Pick." {a="A"}
 When
  scenario s(note:text) by=members
   do
    let x=1
 Then
"#;
    let diags = check(src, None);
    assert_findings(src, &diags, &[("E2002", "Triage", 2)]);
}

/// Import checking still rejects undeclared members.
#[test]
fn judgment_import_undeclared_still_e2004() {
    let src = r#"package p
 use p {Nope} from=deployment.x
 Given
  M {x:text}
  policy M read=members
 When
  scenario s(note:text) by=members
   do
    let x=1
 Then
"#;
    let diags = check(src, None);
    assert_findings(src, &diags, &[("E2004", "Nope", 1)]);
}

/// A duplicate trusted handler keeps `event` (lookup succeeds via the
/// first symbol). The lookup-failure variant is covered below.
#[test]
fn failed_trusted_handler_keeps_event() {
    let src = r#"app T
Given
 event E {source:text}
 M {x:text}
 policy M read=members
When
 scenario dup on=E
  do
   let b=1
 scenario dup on=E
  do
   let a=event.source
   for m in M limit=1
    require event.source==m.x
Then
"#;
    let diags = check(src, None);
    assert_findings(src, &diags, &[("E2002", "dup", 2)]);
}

/// A trusted handler whose declaration failed with no symbol at all
/// (closed-builtin name, CanRent `money` shape) still resolves its
/// body as trusted: injected `event` works in plain and `for`
/// positions (CanRent:1327-70).
#[test]
fn failed_trusted_handler_builtin_name_keeps_event() {
    let catalog = trim_catalog();
    let src = r#"app T
Given
 event E {source:text}
 M {x:text}
 policy M read=members
When
 scenario trim on=E
  do
   let a=event.source
   for m in M limit=1
    require event.source==m.x
Then
"#;
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E2002", "trim", 1)]);
}

/// A failed PLAIN scenario stays untrusted: `event` in its body is
/// still an error (guards against over-eager event binding).
#[test]
fn failed_plain_scenario_stays_untrusted() {
    let src = r#"app T
Given
 M {x:text}
 policy M read=members
When
 scenario dup(note:text) by=members
  do
   let b=1
 scenario dup(note:text) by=members
  do
   let a=event
Then
"#;
    let diags = check(src, None);
    assert_findings(src, &diags, &[("E2002", "dup", 2), ("E2001", "event", 1)]);
}

/// CHARACTERIZATION (types-pass gap, NOT fixed here): `set x.parent`
/// fails where the same path resolves in expression position. The
/// types pass must mirror parent navigation into path targets; flip
/// this expectation when it does.
#[test]
fn set_parent_target_parity() {
    let src = r#"app T
Given
 Cafe {location:text}
 Table in Cafe {seats:int}
 policy Cafe read=members
 policy Table read=members
When
 scenario s(t:Table) by=members
  require t.parent.location!="x"
  do
   set t.parent {location="y"}
Then
"#;
    let diags = check(src, None);
    // G1 fixed in the types pass: `set t.parent` resolves exactly where
    // the expression read resolves, so no E2013 remains on either line.
    assert_findings(src, &diags, &[]);
}

// --- T35/R23: imported CRUD aliases target the canonical owner's
// operation symbols ---------------------------------------------------
// Table-level pins for the resolve pass: the importer's
// `{Importer}.{Model}.{op}` keys alias the owner's operation symbols
// (identity preserved), gated per-op on the owner's `crud`
// declaration. Ambiguous same-named models and self-imports never
// disturb canonicals.

/// Resolve one source through the resolve pass only.
fn resolve_src(src: &str) -> (ResolveTables, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (tree, mut diags) = syntax::parse(&db, id);
    assert!(
        diags.iter().all(|d| !d.code.starts_with("E1")),
        "case must parse, got {diags:?}\nsource:\n{src}"
    );
    let trees = vec![(id, tree)];
    let tables = resolve::resolve_program(&db, &trees, None, &mut diags);
    (tables, diags)
}

/// The importer alias points at the owner's operation symbol, whose
/// canonical identity stays owner-qualified (alias, not relocation).
#[test]
fn t35r23_alias_targets_owner_operation() {
    let src = r#"package stock
 Given
  export Widget { title:text }
  policy Widget read=members
 When
  crud Widget by=members fields=title
 Then
package shop
 use stock {Widget}
 Given
 When
  scenario go(w:Widget) by=members
   do
    let x = 1
 Then
"#;
    let (tables, diags) = resolve_src(src);
    assert!(diags.is_empty(), "resolve clean: {diags:?}");
    let owner = tables.by_canonical.get("stock.Widget.update").copied();
    let alias = tables.by_canonical.get("shop.Widget.update").copied();
    assert!(owner.is_some(), "owner op registered");
    assert_eq!(alias, owner, "importer alias targets owner op");
    let id = owner.unwrap();
    assert_eq!(
        tables.symbols[id.0 as usize].canonical,
        "stock.Widget.update"
    );
    assert_eq!(
        tables.symbols[id.0 as usize].module,
        tables.module_by_name["stock"]
    );
    assert_eq!(
        tables.by_canonical.get("shop.Widget.create").copied(),
        tables.by_canonical.get("stock.Widget.create").copied()
    );
    assert_eq!(
        tables.by_canonical.get("shop.Widget.delete").copied(),
        tables.by_canonical.get("stock.Widget.delete").copied()
    );
}

/// Per-op granularity: a disabled operation gets no alias while its
/// enabled siblings do.
#[test]
fn t35r23_disabled_operation_has_no_alias() {
    let src = r#"package stock
 Given
  export Gadget { title:text }
  policy Gadget read=members
 When
  crud Gadget by=members fields=title update=none
 Then
package shop
 use stock {Gadget}
 Given
 When
  scenario go(g:Gadget) by=members
   do
    let x = 1
 Then
"#;
    let (tables, diags) = resolve_src(src);
    assert!(diags.is_empty(), "resolve clean: {diags:?}");
    assert!(
        !tables.by_canonical.contains_key("stock.Gadget.update"),
        "owner registers no disabled op"
    );
    assert!(
        !tables.by_canonical.contains_key("shop.Gadget.update"),
        "disabled op gets no importer alias"
    );
    assert_eq!(
        tables.by_canonical.get("shop.Gadget.delete").copied(),
        tables.by_canonical.get("stock.Gadget.delete").copied()
    );
    assert!(
        tables.by_canonical.contains_key("shop.Gadget.delete"),
        "enabled sibling still aliases"
    );
}

/// Ambiguity stays conservative: one importer, same model name from
/// two owners — no alias either way, so both sequence calls keep
/// `E5006` (the call-site key cannot express which owner a call
/// means).
#[test]
fn t35r23_ambiguous_model_names_have_no_alias() {
    let src = r#"package stock
 Given
  export Widget { title:text }
  policy Widget read=members
  export fixture w=Widget {title="a"}
 When
  crud Widget by=members fields=title
 Then
package depot
 Given
  export Widget { title:text }
  policy Widget read=members
 When
  crud Widget by=members fields=title
 Then
package shop
 use stock {Widget,w}
 use depot {Widget as DepotWidget}
 Given
 When
  scenario go() by=members
   do
    let x = 1
   examples seed=[w]
    do
     call go {} by=self
     call Widget.update {record=w,changes={title="b"}} by=self
     call DepotWidget.update {record=w,changes={title="b"}} by=self
     w.title -> "b"
 Then
"#;
    let (tables, _) = resolve_src(src);
    assert!(
        !tables.by_canonical.contains_key("shop.Widget.update"),
        "ambiguous name gets no alias"
    );
    assert!(
        !tables.by_canonical.contains_key("shop.Widget.create")
            && !tables.by_canonical.contains_key("shop.Widget.delete"),
        "ambiguity skips every op"
    );
    let diags = check(src, None);
    assert_findings(
        src,
        &diags,
        &[
            ("E5006", "Widget.update", 1),
            ("E5006", "DepotWidget.update", 1),
        ],
    );
}

/// Self-imports never disturb canonicals: the local key keeps the
/// local operation, and no alias appears under the import alias.
#[test]
fn t35r23_self_import_leaves_canonical_untouched() {
    let src = r#"package shop
 use shop {Widget as Local}
 Given
  export Widget { title:text }
  policy Widget read=members
 When
  crud Widget by=members fields=title
 Then
"#;
    let (tables, diags) = resolve_src(src);
    assert!(diags.is_empty(), "resolve clean: {diags:?}");
    let local = tables.by_canonical.get("shop.Widget.update").copied();
    assert!(local.is_some(), "local op registered");
    assert_eq!(
        tables.symbols[local.unwrap().0 as usize].module,
        tables.module_by_name["shop"]
    );
    assert!(
        !tables.by_canonical.contains_key("shop.Local.update"),
        "no alias under the import alias"
    );
}
