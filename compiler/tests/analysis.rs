//! PR4 analysis tests: name resolution (`E2xxx`), type checking (`E3xxx`)
//! and the producer-catalog loader (`E6xxx`).
//!
//! Invalid-case tables assert exact codes plus exact primary spans; the
//! span of each expectation is derived from a needle substring of the
//! case source (1-based occurrence counting), so a wrong span
//! fails even when the code is right. `E6002` anchors on an empty `(0,0)`
//! span and is asserted separately. The `explain` round-trip mirrors the
//! `E1xxx` discipline: every `example_invalid` emits its code, every
//! `example_valid` checks clean, and the observed set equals the catalog
//! set. Examples and drafts run against the real lane-02 catalog when its
//! `dist` output exists and skip honestly otherwise; the remaining tests
//! use an explicitly test-only inline fixture whose builtin shapes are
//! transcribed from the DESIGN §3 notation block (never copied from a
//! producer file) plus two synthetic entries (`planned_widget`,
//! `help_inner`) that no producer emits.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::cli::{Analyzer, CatalogAnalyzer, dispatch, dispatch_with};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::explain;
use canlang_compiler::source::{SourceDb, Span};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Fresh unique scratch directory under the system temp dir.
fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "can-analysis-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_file(dir: &Path, name: &str, content: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    path
}

/// Explicitly test-only catalog: builtin shapes transcribed from the
/// DESIGN §3 notation block plus the §2.2 `invocation` constructor, plus
/// synthetic `planned_widget` (planned) and `help_inner` (helper)
/// entries no producer emits.
const FIXTURE_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-0",
  "entries": [
    {"id": "count", "js": "count", "owner": "test", "kind": "builtin", "signature": "count(domain:C<T>)->int", "effects": "pure", "availability": "implemented"},
    {"id": "min", "js": "min", "owner": "test", "kind": "builtin", "signature": "min(domain:C<O>)->O?; min(domain:nonempty C<O>)->O", "effects": "pure", "availability": "implemented"},
    {"id": "max", "js": "max", "owner": "test", "kind": "builtin", "signature": "max(domain:C<O>)->O?; max(domain:nonempty C<O>)->O", "effects": "pure", "availability": "implemented"},
    {"id": "first", "js": "first", "owner": "test", "kind": "builtin", "signature": "first(domain:ordered C<T>)->T?", "effects": "pure", "availability": "implemented"},
    {"id": "trim", "js": "trim", "owner": "test", "kind": "builtin", "signature": "trim(value:S)->text", "effects": "pure", "availability": "implemented"},
    {"id": "local_instant", "js": "localInstant", "owner": "test", "kind": "builtin", "signature": "local_instant(date:date,time:text,zone:timezone,fold:enum(earlier,later))->datetime", "effects": "pure", "availability": "implemented"},
    {"id": "action", "js": "action", "owner": "test", "kind": "builtin", "signature": "action(target:canonical user mutation,bindings:closed object of every record parameter)->singleton action(target)", "effects": "pure", "availability": "implemented"},
    {"id": "invocation", "js": "invocation", "owner": "test", "kind": "builtin", "signature": "invocation(target:canonical local user mutation,arguments:complete owning input object)->singleton invocation(target)", "effects": "pure", "availability": "implemented"},
    {"id": "all", "js": "all", "owner": "test", "kind": "builtin", "signature": "all(domain:C<T> as x,predicate:bool in x scope)->bool", "effects": "pure", "availability": "implemented"},
    {"id": "planned_widget", "js": "plannedWidget", "owner": "test", "kind": "builtin", "signature": "planned_widget(domain:C<int>)->int", "effects": "pure", "availability": "planned"},
    {"id": "help_inner", "js": "helpInner", "owner": "test", "kind": "helper", "signature": "help_inner(value:int)->int; JS-side helper", "effects": "pure", "availability": "implemented"},
    {"id": "random_secret", "js": "randomSecret", "owner": "test", "kind": "builtin", "signature": "random_secret()->secret", "effects": "server-default-only", "availability": "implemented"}
  ]
}"#;

/// Load one catalog JSON document through a temp file.
fn load_json_catalog(json: &str) -> (Option<Catalog>, Vec<Diagnostic>) {
    let dir = scratch_dir();
    let path = write_file(&dir, "catalog.json", json);
    let mut db = SourceDb::new();
    let id = db.add("dummy.can".to_string(), String::new());
    let request = CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(id, 0, 0),
    };
    load_catalog(&request)
}

/// The test-only fixture catalog (panics unless it loads clean).
fn fixture() -> Catalog {
    let (catalog, diags) = load_json_catalog(FIXTURE_JSON);
    assert!(diags.is_empty(), "fixture must load clean: {diags:?}");
    catalog.expect("fixture catalog")
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

/// Assert one source checks fully clean.
#[track_caller]
fn assert_clean(src: &str, catalog: Option<&Catalog>) {
    let diags = check(src, catalog);
    assert!(
        diags.is_empty(),
        "expected clean, got {diags:?}\nsource:\n{src}"
    );
}

#[test]
fn unknown_names_and_cascade_suppression() {
    let catalog = fixture();
    // One E2001 per use site; the poisoned expression emits nothing
    // further (no E3002 for `+` on the unknown).
    let src = "app T\nGiven\n derive bad(): int = nosuch + 1\nWhen\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2001", "nosuch", 1)]);
    // Member access on an unknown root: the root only.
    let src = "app T\nGiven\n derive bad(): int = nosuch.field\nWhen\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2001", "nosuch", 1)]);
    // Two sites, two diagnostics.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require aaa == 1 and zzz == 2\n  do\n   let x = 1\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E2001", "aaa", 1), ("E2001", "zzz", 1)],
    );
    // A cross-package path without its `use` is E2001, not E2005.
    let src = "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n Given\n  N { m:p.M }\n When\n Then\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2001", "p.M", 1)]);
}

#[test]
fn duplicates() {
    let catalog = fixture();
    // Second model binds the duplicate; the span is its name.
    let src = "app T\nGiven\n M { a:int }\n M { b:int }\nWhen\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2002", "M", 2)]);
    // Duplicate parameter.
    let src =
        "app T\nGiven\nWhen\n scenario s(qq:int, qq:int) by=members\n  do\n   let x = 1\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2002", "qq", 2)]);
    // Closed builtin names cannot be redeclared while the catalog
    // defines them.
    let src = "app T\nGiven\n count { x:int }\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E2002", "count", 1)]);
    assert!(
        diags[0].message.contains("closed builtin name"),
        "{}",
        diags[0].message
    );
    // Duplicate enum case.
    let src = "app T\nGiven\n M { s:enum(qq,qq)=qq }\n policy M read=members\nWhen\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2002", "qq", 2)]);
}

#[test]
fn imports_and_visibility() {
    let catalog = fixture();
    // Declared but not exported.
    let src = "app T uses=[p,q]\npackage p\n Given\n  M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {M}\n Given\n When\n Then\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2003", "M", 3)]);
    // Not declared in the provider.
    let src = "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {Zzz}\n Given\n When\n Then\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2004", "Zzz", 1)]);
    // Unknown provider.
    let src = "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use zzz {M}\n Given\n When\n Then\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2005", "zzz", 1)]);
    // A composed app imports messages only.
    let src = "app T uses=[p]\nuse p {M}\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2009", "M", 1)]);
    // Empty selection, spanning the app name.
    let src = "app T uses=[]\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2010", "T", 1)]);
    // Composition cycles report every app on the cycle.
    let src = "app A uses=[B]\napp B uses=[A]\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E2007", "A", 1), ("E2007", "B", 2)],
    );
}

#[test]
fn suffix_bang_and_default_order() {
    let catalog = fixture();
    // Suffixes apply once, on the resolved (possibly reused) type.
    let src = "app T\nGiven\n M { t:text[] }\n N { u:M.t[] }\n policy M read=members\n policy N read=members\nWhen\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E3008", "M.t[]", 1)]);
    let src = "app T\nGiven\n M { t:text? }\n N { u:M.t? }\n policy M read=members\n policy N read=members\nWhen\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E3008", "M.t?", 1)]);
    // `!` off a required array input: one diagnostic naming the type.
    let src = "app T\nGiven\n M { t:text }\n N { u:M.t! }\n policy M read=members\n policy N read=members\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E3008", "u:M.t!", 1)]);
    assert!(diags[0].message.contains("on text"), "{}", diags[0].message);
    // `[]!` is the required-array form and checks clean.
    assert_clean(
        "app T\nGiven\n M { t:text[]! }\n policy M read=members\nWhen\nThen\n",
        Some(&catalog),
    );
    // Defaults reference earlier parameters only; a later one is not
    // in scope at the default.
    let src =
        "app T\nGiven\nWhen\n scenario s(a:int=b, b:int) by=members\n  do\n   let x = 1\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E2001", "b", 1)]);
    assert_clean(
        "app T\nGiven\nWhen\n scenario s(a:int, b:int=a) by=members\n  do\n   let x = 1\nThen\n",
        Some(&catalog),
    );
}

#[test]
fn operator_matrix() {
    let catalog = fixture();
    // Unlisted operand pairs are E3002, spanning the operation.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n scenario s(t:Todo) by=members\n  require 1 + true == 2\n  do\n   let x = 1\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E3002", "1 + true", 1)],
    );
    // Money never mixes with plain numbers, even for `+`.
    let src = "app T\nGiven\n M { m:money }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require m.m + 1 == m.m\n  do\n   let x = 1\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E3002", "m.m + 1", 1)]);
    // Enums never order.
    let src = "app T\nGiven\n M { s:enum(a,b)=a }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require m.s < m.s\n  do\n   let x = 1\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E3002", "m.s < m.s", 1)],
    );
    // No implicit concatenation: text `+` text is outside the matrix
    // (sequences are arrays).
    let src = "app T\nGiven\n derive bad(): text = \"a\" + \"b\"\nWhen\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E3002", "\"a\" + \"b\"", 1)],
    );
    // Listed rows check clean: int/decimal promotion, money scale
    // factors, duration ratios, datetime shifts, array concat.
    assert_clean(
        "app T\nGiven\n derive ok(): decimal = 1 + 2.5\nWhen\nThen\n",
        Some(&catalog),
    );
    assert_clean(
        "app T\nGiven\n M { m:money }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require m.m * 2 == m.m\n  do\n   let x = 1\nThen\n",
        Some(&catalog),
    );
    assert_clean(
        "app T\nGiven\n M { d:duration }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require m.d / m.d > 0\n  do\n   let x = 1\nThen\n",
        Some(&catalog),
    );
    assert_clean(
        "app T\nGiven\n M { d:datetime, t:duration }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require m.d + m.t > now\n  do\n   let x = 1\nThen\n",
        Some(&catalog),
    );
    assert_clean(
        "app T\nGiven\n derive ok(): int[] = [1,2] + [3]\nWhen\nThen\n",
        Some(&catalog),
    );
}

#[test]
fn catalog_missing_unavailable_and_helper_misuse() {
    let catalog = fixture();
    // Without a catalog, builtin names do not resolve (exactly E2001;
    // the missing file itself is E6002 at the loader/CLI level below).
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive ok(): int = count(Todo)\nWhen\nThen\n";
    assert_findings(src, &check(src, None), &[("E2001", "count", 1)]);
    // A missing catalog file is one precise E6002 naming every spot
    // tried plus how to produce the file, anchored on the caller's span.
    let dir = scratch_dir();
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let request = CatalogRequest {
        flag: Some(&dir.join("flag-catalog.json")),
        env: None,
        cwd: &dir,
        primary: Span::new(id, 0, 0),
    };
    let (loaded, diags) = load_catalog(&request);
    assert!(loaded.is_none());
    assert_eq!(diags.len(), 1, "{diags:?}");
    assert_eq!(diags[0].code, "E6002");
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (0, 0));
    for needle in [
        "flag-catalog.json",
        "CAN_CATALOG",
        "can-catalog.json",
        "packages/values/dist/catalog.json",
        "npm run catalog",
    ] {
        assert!(diags[0].message.contains(needle), "{}", diags[0].message);
    }
    // A planned builtin call is E6001 on the callee even when the
    // arguments would also mismatch (availability first, no E3005).
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive bad(): int = planned_widget()\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E6001", "planned_widget", 1)]);
    assert!(
        diags[0].message.contains("owner: test"),
        "{}",
        diags[0].message
    );
    // Helpers are codegen-only in call and bare positions alike.
    let src = "app T\nGiven\n derive bad(): int = help_inner(1)\nWhen\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E2006", "help_inner", 1)],
    );
    let src = "app T\nGiven\n derive bad(): int = help_inner\nWhen\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E2006", "help_inner", 1)],
    );
}

#[test]
fn signature_shape_gaps() {
    // Unknown kind/effects/availability spellings are E6003.
    for (name, entry) in [
        (
            "kind",
            r#"{"id":"w","kind":"spell","signature":"w()->int","effects":"pure","availability":"implemented"}"#,
        ),
        (
            "effects",
            r#"{"id":"w","kind":"builtin","signature":"w()->int","effects":"chaotic","availability":"implemented"}"#,
        ),
        (
            "availability",
            r#"{"id":"w","kind":"builtin","signature":"w()->int","effects":"pure","availability":"eventually"}"#,
        ),
        (
            "missing-signature",
            r#"{"id":"w","kind":"builtin","effects":"pure","availability":"implemented"}"#,
        ),
    ] {
        let json = format!(
            "{{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[{entry}]}}"
        );
        let (catalog, diags) = load_json_catalog(&json);
        assert!(catalog.is_none(), "{name}: {catalog:?}");
        assert_eq!(diags.len(), 1, "{name}: {diags:?}");
        assert_eq!(diags[0].code, "E6003", "{name}: {diags:?}");
    }
    // Malformed overloads are E6004, not guesses.
    for (name, signature) in [
        ("prose", "not a signature"),
        ("wrong-id", "other()->int"),
        ("empty-segment", "w()->int; "),
        ("empty", ""),
    ] {
        let json = format!(
            "{{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[{{\"id\":\"w\",\"owner\":\"t\",\"kind\":\"builtin\",\"signature\":\"{signature}\",\"effects\":\"pure\",\"availability\":\"implemented\"}}]}}"
        );
        let (catalog, diags) = load_json_catalog(&json);
        assert!(catalog.is_none(), "{name}: {catalog:?}");
        assert_eq!(diags.len(), 1, "{name}: {diags:?}");
        assert_eq!(diags[0].code, "E6004", "{name}: {diags:?}");
    }
    // A helper without its `id(...)->...` spine is E6004.
    let json = "{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[{\"id\":\"h\",\"owner\":\"t\",\"kind\":\"helper\",\"signature\":\"just prose\",\"effects\":\"pure\",\"availability\":\"implemented\"}]}";
    let (catalog, diags) = load_json_catalog(json);
    assert!(catalog.is_none());
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6004");
    // Envelope faults are E6003.
    for (name, json) in [
        (
            "lang",
            "{\"language_version\":\"2.0\",\"catalog_version\":\"t\",\"entries\":[]}",
        ),
        (
            "lang-null",
            "{\"language_version\":null,\"catalog_version\":\"t\",\"entries\":[]}",
        ),
        (
            "no-version",
            "{\"language_version\":\"1.0\",\"entries\":[]}",
        ),
        (
            "no-entries",
            "{\"language_version\":\"1.0\",\"catalog_version\":\"t\"}",
        ),
        ("not-json", "{oops"),
        ("not-envelope", "[1,2]"),
    ] {
        let (catalog, diags) = load_json_catalog(json);
        assert!(catalog.is_none(), "{name}: {catalog:?}");
        assert_eq!(diags.len(), 1, "{name}: {diags:?}");
        assert_eq!(diags[0].code, "E6003", "{name}: {diags:?}");
    }
    // Duplicate ids are E6003 naming the id.
    let json = "{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[{\"id\":\"w\",\"owner\":\"t\",\"kind\":\"builtin\",\"signature\":\"w()->int\",\"effects\":\"pure\",\"availability\":\"implemented\"},{\"id\":\"w\",\"owner\":\"t\",\"kind\":\"builtin\",\"signature\":\"w()->int\",\"effects\":\"pure\",\"availability\":\"implemented\"}]}";
    let (catalog, diags) = load_json_catalog(json);
    assert!(catalog.is_none());
    assert_eq!(diags.len(), 1);
    assert_eq!(diags[0].code, "E6003");
    assert!(diags[0].message.contains("'w'"), "{}", diags[0].message);
    // The empty catalog is valid (no builtins resolve, nothing breaks).
    let (catalog, diags) = load_json_catalog(
        "{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[]}",
    );
    assert!(diags.is_empty(), "{diags:?}");
    assert!(catalog.expect("empty catalog").ids().next().is_none());
}

/// Valid corpus: every source checks fully clean. These pin predecessor
/// bug fixes (exported models, forward field chains, builtin-spelled
/// enum cases, parent/child navigation, narrowing, enum-typed catalog
/// arguments, action bindings) plus core call shapes.
#[test]
fn valid_corpus_checks_clean() {
    let catalog = fixture();
    let cases = [
        // Exported models type their fields like local ones.
        "app T\nGiven\n export M { s:enum(a,b)=a }\n policy M read=members\nWhen\nThen\n",
        "app T\nGiven\n export M { s:enum(a,b)=a }\n policy M read=members\n lock M fields=s when=row.s!=a\nWhen\nThen\n",
        "app T\nGiven\n export M { s:enum(a,b)=a, t:text }\n policy M read=members\n fixture f=M {s=a,t=\"x\"}\nWhen\nThen\n",
        // Forward field-chain references resolve regardless of order.
        "app T\nGiven\n preferences { v:M.s=a }\n M { s:enum(a,b)=a }\n policy M read=members\nWhen\nThen\n page / title=\"T\"\n  tabs preferences.v\n",
        // Builtins are callable names, not lexical bindings: a
        // same-spelled enum case still elides, in either order.
        "app T\nGiven\n preferences { v:enum(all,x)=all }\nWhen\nThen\n page / title=\"T\"\n  tabs preferences.v\n",
        "app T\nGiven\n M { s:enum(all,x)=all }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require all==m.s and m.s==all and (all)==m.s\n  do\n   let x = 1\nThen\n",
        // Contained navigation: `row.parent` and `parentRecord.Child`.
        "app T\nGiven\n Cafe { location:text }\n Table in Cafe { seats:int }\n policy Cafe read=members\n policy Table read=members\n lock Table fields=seats when=row.parent.location==\"x\"\nWhen\nThen\n",
        "app T\nGiven\n Cafe { location:text }\n Table in Cafe { seats:int }\n policy Cafe read=members\n policy Table read=members\nWhen\n scenario s(c:Cafe) by=members\n  require count(c.Table) >= 0\n  do\n   let x = 1\nThen\n",
        // Safe-access equality narrows the continuation; `is` narrows too.
        "app T\nGiven\n M { u:M?, title:text }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require m.u?.title==\"x\" and m.u.title!=\"y\"\n  do\n   let x = 1\nThen\n",
        "app T\nGiven\n contract Address {street:text,city:text}\nWhen\n scenario s(j:json) by=members\n  require j is Address and j.street != \"\"\n  do\n   let x = 1\nThen\n",
        // Enum-typed values match signature case lists by subset.
        "app T\nGiven\n M { d:date, t:text, z:timezone, f:enum(earlier,later) }\n policy M read=members\nWhen\n scenario s(m:M) by=members\n  require local_instant(m.d,m.t,m.z,fold=m.f) > now\n  do\n   let x = 1\nThen\n",
        // Action constructors bind every record parameter.
        "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\n scenario s(t:Todo) by=members\n  do\n   let a = action(Todo.update, {record=t})\nThen\n",
        // Core call shapes: queries, nonempty proofs, stable firsts.
        "app T\nGiven\n Todo { title:text, done:bool }\n policy Todo read=members\n derive ok(): int = count(Todo as t where t.done)\nWhen\nThen\n",
        "app T\nGiven\n derive ok(): int = min([1,2])\nWhen\nThen\n",
        "app T\nGiven\n M { n:int }\n policy M read=members\n derive ok(): int? = min(M as m select m.n)\nWhen\nThen\n",
        "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive ok(): Todo? = first(Todo)\nWhen\nThen\n",
        "app T\nGiven\nWhen\n scenario s(note:text) by=members\n  require trim(note)!=\"\"\n  do\n   let x = 1\nThen\n",
        "app T\nGiven\n Todo { title:text, done:bool }\n policy Todo read=members\n derive ok(): bool = all(Todo as t, t.done)\nWhen\nThen\n",
        // Imports, containment and composition compose.
        "app T uses=[p,q]\npackage p\n Given\n  export M { a:int }\n  policy M read=members\n When\n Then\npackage q\n use p {M}\n Given\n When\n  scenario s(m:M) by=members\n   do\n    let x = 1\n Then\n",
        "app T uses=[p]\npackage p\n Given\n When\n Then\n",
    ];
    for (index, src) in cases.iter().enumerate() {
        let diags = check(src, Some(&catalog));
        assert!(
            diags.is_empty(),
            "case {index} got {diags:?}\nsource:\n{src}"
        );
    }
}

/// `explain` round-trip for `E2xxx`/`E3xxx`/`E4xxx`/`E5xxx`/
/// `E6001`/`E6002`: every `example_invalid` emits its code, every
/// `example_valid` checks clean (against the fixture; `E6002` invalid
/// runs without a catalog), and the observed code set equals the catalog
/// set for the range.
#[test]
fn explain_round_trip_source_codes() {
    let catalog = fixture();
    let entries: Vec<_> = explain::all()
        .iter()
        .filter(|info| {
            info.code.starts_with("E2")
                || info.code.starts_with("E3")
                || info.code.starts_with("E4")
                || info.code.starts_with("E5")
                || info.code == "E6001"
                || info.code == "E6002"
        })
        .collect();
    assert_eq!(
        entries.len(),
        15 + 19 + 13 + 9 + 2,
        "E2/E3/E4/E5/E6001/E6002 entry count"
    );
    let mut seen = BTreeSet::new();
    for info in &entries {
        // E6002 comes from the loader rather than the source pipeline:
        // a missing file plus the unresolvable source it leaves behind.
        let diags = if info.code == "E6002" {
            let dir = scratch_dir();
            let mut db = SourceDb::new();
            let id = db.add("test.can".to_string(), info.example_invalid.to_string());
            let request = CatalogRequest {
                flag: Some(&dir.join("absent.json")),
                env: None,
                cwd: &dir,
                primary: Span::new(id, 0, 0),
            };
            let (loaded, mut load_diags) = load_catalog(&request);
            assert!(loaded.is_none(), "E6002 invalid unexpectedly loaded");
            let (_program, check_diags) = check_program(&db, &[id], None);
            load_diags.extend(check_diags);
            load_diags
        } else {
            check(info.example_invalid, Some(&catalog))
        };
        let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
        assert!(
            codes.contains(&info.code),
            "{} invalid did not emit {}: {codes:?}\nsource:\n{}",
            info.code,
            info.code,
            info.example_invalid
        );
        seen.extend(codes.iter().map(|c| c.to_string()));
        let valid = check(info.example_valid, Some(&catalog));
        assert!(
            valid.is_empty(),
            "{} valid is not clean: {valid:?}\nsource:\n{}",
            info.code,
            info.example_valid
        );
        let json = explain::entry_to_json(info);
        assert!(!json.contains('\n'), "single-line JSON");
        assert!(json.contains(info.code), "{json}");
        let text = explain::entry_to_text(info);
        assert!(
            text.contains(info.code) && text.contains(info.title),
            "{text}"
        );
    }
    let documented: BTreeSet<String> = entries.iter().map(|info| info.code.to_string()).collect();
    assert_eq!(
        seen, documented,
        "observed codes must equal catalog entries"
    );
}

/// `explain` round-trip for the loader codes: `E6003`/`E6004` examples
/// are catalog JSON, checked through the loader rather than the source
/// pipeline.
#[test]
fn explain_round_trip_loader_codes() {
    for code in ["E6003", "E6004"] {
        let info = explain::lookup(code).unwrap_or_else(|| panic!("{code} entry"));
        let (catalog, diags) = load_json_catalog(info.example_invalid);
        assert!(catalog.is_none(), "{code} invalid loaded: {catalog:?}");
        assert_eq!(diags.len(), 1, "{code}: {diags:?}");
        assert_eq!(diags[0].code, code, "{code}: {diags:?}");
        let (catalog, diags) = load_json_catalog(info.example_valid);
        assert!(diags.is_empty(), "{code} valid: {diags:?}");
        assert!(catalog.is_some(), "{code} valid must load");
    }
}

/// Workspace root (parent of this package) for example/draft paths.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// The real lane-02 catalog when its `dist` output exists: `None`
/// (honest skip) otherwise. Never writes producer output.
fn real_catalog_path() -> Option<PathBuf> {
    let path = workspace_root().join("packages/values/dist/catalog.json");
    path.is_file().then_some(path)
}

/// Load the real catalog through the production flag path.
fn load_real_catalog(path: &Path) -> Catalog {
    let mut db = SourceDb::new();
    let id = db.add("dummy.can".to_string(), String::new());
    let request = CatalogRequest {
        flag: Some(path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(id, 0, 0),
    };
    let (catalog, diags) = load_catalog(&request);
    assert!(diags.is_empty(), "real catalog must load clean: {diags:?}");
    catalog.expect("real catalog")
}

#[test]
fn team_tasks_checks_clean() {
    let Some(path) = real_catalog_path() else {
        eprintln!("SKIP team_tasks_checks_clean: no packages/values/dist/catalog.json");
        return;
    };
    let catalog = load_real_catalog(&path);
    let src = std::fs::read_to_string(workspace_root().join("examples/TeamTasks.can")).unwrap();
    assert_clean(&src, Some(&catalog));
}

/// ExpenseFlow checks clean against the real catalog. History: it
/// carried one `E6001` while lane-02 marked `sum` planned; the flag
/// flipped to implemented with lane-02 PR5 (stdlib-pure dispatchers) and
/// the tripwire below pins the new state — it fails if `sum` ever flips
/// back or the example regresses.
#[test]
fn expense_flow_checks_clean_with_implemented_sum() {
    let Some(path) = real_catalog_path() else {
        eprintln!(
            "SKIP expense_flow_checks_clean_with_implemented_sum: no packages/values/dist/catalog.json"
        );
        return;
    };
    let catalog = load_real_catalog(&path);
    assert_eq!(
        catalog.availability("sum"),
        Some(canlang_compiler::analysis::catalog::Availability::Implemented),
        "sum availability flipped back to planned: revisit ExpenseFlow expectations",
    );
    let src = std::fs::read_to_string(workspace_root().join("examples/ExpenseFlow.can")).unwrap();
    assert_clean(&src, Some(&catalog));
}

/// Per-file draft outcome table. Drafts are pre-v1 sources: cross-file
/// providers do not resolve in single-file checks and old spellings
/// drifted, so every file fails. The table pins exact counts (a change
/// means the checker or a draft moved: update deliberately, never fix a
/// draft here) and audits that no draft emits an undocumented code.
#[test]
fn draft_outcome_table() {
    let Some(path) = real_catalog_path() else {
        eprintln!("SKIP draft_outcome_table: no packages/values/dist/catalog.json");
        return;
    };
    let catalog = load_real_catalog(&path);
    // (file, expected diagnostic count). Counts regenerated 2026-10-05
    // for B4 closeout (6 compiler-gap packets F1-F6). Table total moved
    // 7474 -> 6963 (-511). Adds are proven true-positives: the `each=`
    // fix keeps E1203 but stops dropping the package from the module
    // index, so CanShift 4 -> 257 and CanVolunteer 3 -> 85 now show
    // genuine analysis diagnostics across previously-unchecked bodies
    // (code mix audited: E2001/E3001/E3003/E2013, no parser storm);
    // new E3019 (opaque capability receipts) adds findings where sends
    // were silently unchecked (CanField 116 -> 124 = +9 E3019, -1 fix).
    // All other moves are decreases from gap fixes (judgment
    // registration, event-payload typing, auth narrowing, empty-array
    // unification, selector delivery leaves, examples-header elision,
    // format-descriptor typing, set-target parent parity, timeline row
    // binding), each with failing-first regression tests in
    // compiler/tests/b4_*.rs. Pre-B4 regen 2026-10-04
    // for PR6 (slice-23 example drift + 2 checker fixes), attribution
    // proven per file against a PR5-merged binary on the same drafts:
    // E2 -778 (781 catalog-header E2001s silenced by the M6 extension,
    // 3 E2013 row-member finds on CanCheck from typed rows); E3 -3 net
    // (+2 CanDesk member/type finds, -5 cascades incl. 2 E3001
    // follow-ons sampled on CanRent); E1/E4/E5 unchanged (E4 still 0,
    // E5 26 after draft-side moves). (Pre-B4: CanShift 4 /
    // CanVolunteer 3 held while `each=` dropped the packages.)
    // Checker-attributed movement is -781; the table total moved 8196
    // -> 7474 (-722), so draft-side slices 16-23 replans between the
    // two regens contribute +59 net drift (real, confirmed movement).
    // Previous regen (PR5 review fixes) (M1: the dedup key now includes
    // end+message), restoring 249 findings the old (file, start, code)
    // key had collapsed (E2 +14, E3 +233, E5 +2 -- CanCRM and CanTable
    // each regain one intra-pass E5 repeat). Attribution is measured
    // in-tree: the undeduped manual pipeline against check_program on
    // the same drafts gives pre==post in every group (E1 4, E2 4773,
    // E3 3393, E4 0, E5 26), so the new key removes 0 on drafts and
    // every restored finding differed in end or message; the old-key
    // run reproduces the previous table 52/52, pinning all movement to
    // the key change (B1-B4/M3/N1 move no draft).
    // E4 adds 0 everywhere (effects skip `has_error` subtrees and drafts
    // are pre-v1 sources failing early -- by design); E5 adds 26 total
    // across 10 files (CanCRM 4, CanDesk 1, CanEvent 2, CanInvoice 1,
    // CanLeave 6, CanPropose 2, CanPurchase 5, CanRefer 1, CanReport 2,
    // CanTable 2). This table pins the error-skip behavior, not E4
    // precision/recall (that evidence rests on the unit tests and the
    // explain round-trip). (Pre-B4: CanShift 4 /
    // CanVolunteer 3 held while `each=` dropped the packages.)
    // Previous regen (PR5): PR5 = PR4 - dedup + E5, attribution against
    // a PR4 binary; all other E1/E2/E3 moves were draft-side replans on
    // main (50 files, slices #102-#110). Previous regen (PR4 review
    // fixes): B4 types `invocation(...)` positions (CanWorkbench +2: the
    // line-15 target E2001s) and M6 resolves `slot`/catalog-item subtrees
    // like their siblings (all other moves are UI-subtree E2001/E2013s
    // under identical scoping, each family audited: no new codes, no
    // other adds) plus the PR5B carryover (CanCreative -1:
    // `application/json` fixture type now accepted per DESIGN §5).
    // T14b re-pin 2026-10-05 (T13b send/recipe validation via the
    // lifted scope gate + B1/B11 nominal reachability): 24 files
    // net-decrease, 28 unchanged, zero net-increase; table total
    // -186. Whole-corpus (all-52) differential 2391 -> 2205 (-186):
    // removed 200 = E2005 x24 (every unbound-`std` line resolves) +
    // E3019 x22 (every T13b send/recipe validates: Images 10, LLM 7,
    // Post 5; the family is now zero corpus-wide, as is E2005) +
    // E2001 x154 (147 nominal uses + 7 recipe `status=` names now
    // claimed by the validated-recipe envelope). Added 14 = E3001
    // x12 + E3015 x2, all opaque-flow surfacing at newly-reachable
    // nominal positions, each site-audited genuine: 9 under the
    // same-as-local T14 validation rule (send inputs fed by Opaque
    // nominal chains), 5 under the established `types_compatible`
    // rule (fixture/create/derive flows; siblings exist in the
    // baseline). Verification of those flows needs T13 leaf tables
    // (a T13c-style transcription need), never invented here.
    // Per-file nets equal whole-corpus nets per file (the same 14
    // added sites confirmed present in single-file runs; no harness
    // gap). E3010 unchanged: no wrong associations, unknown inputs
    // or missing required inputs in any corpus T13b send/recipe.
    // T14c re-pin 2026-10-05 (typed external deliveries: `std` send
    // receipts and `delivery(std...)` declarations carry their
    // operation identity): 19 files net-decrease, 33 unchanged
    // (CanShift +1/-1 nets 0), zero net-increase; table total -101
    // (5175 -> 5074). Whole-corpus (all-52) differential 2205 ->
    // 2104 (-101): removed 126 = E3001 x108 (same-target receipt
    // compat now passes; `?` no longer swallowed on `std` delivery
    // decls so nullable fields are genuinely optional; precise
    // upstream wrong-leaf E2013s replace vague downstream
    // mismatches via error poisoning; `.id` reads prove text) +
    // E3015 x18 (nullable-delivery requiredness fix in fixtures).
    // Added 25 = E2013 x18 (9 wrong-leaf `progress` rejections
    // naming the receipt identity + 9 over-long
    // `request.progress.*` selector paths failing on the shared
    // delivery-interior arm) + E3008 x7 (non-nullable
    // `delivery(Mail.send)` fields: Book/Contract/Event/Maintain/
    // Rent/Shift/Success). Every other family is bit-identical
    // (E3019/E2005 stay 0; the T14b opaque-mismatch class still
    // fires: zero removals at send-input keys, 262 `found {opaque}`
    // E3001s persist). Per-file nets equal whole-corpus nets per
    // file (no harness gap). Differential isolated without Git: a
    // constructors-only toggle reproduces the pinned baseline
    // 52/52 plus all-52 2205 exactly.
    // T14d re-pin 2026-10-05 (nominal-leaf checker join: `std`
    // receipt `result` resolves through the committed T13c
    // transcription): 52 files unchanged, zero net movement; table
    // total holds at 5074. Whole-corpus (all-52) differential 2104
    // -> 2104 (net 0): removed E3001 x1 (CanCreative:84 `digest`
    // fed by the now-typed `WorkflowValidation.digest: text?`,
    // the opaque-mismatch class resolving per transcription) +
    // added E3004 x1 (CanCreative:270 `fields ?? []`: the
    // established no-coercion `??` rule firing on the now-visible
    // `WorkflowField[]?`, byte-identical in shape to the local
    // `file[]? ?? []` probe on the baseline binary; the only
    // `?? []` site corpus-wide). Every other family is
    // bit-identical in both modes (message-inclusive diff shows
    // exactly one remove/add pair); E3019 unchanged in both modes
    // (0 all-52, 130 single-file). Differential isolated without
    // Git: a temporary T14c-restoration toggle reproduces the
    // pinned baseline 52/52 plus all-52 2104 exactly, and the
    // reverted final tree reproduces the measured new output byte
    // for byte (per-file counts, both family histograms, full
    // all-52 JSON).
    // T07 re-pin 2026-10-05 (filtered row facts: `where` null
    // tests narrow the selected row in following clauses,
    // collection bodies, and `for` bodies): 6 files net-decrease,
    // 46 unchanged, zero net-increase; table total -27 (5074 ->
    // 5047). Whole-corpus (all-52) differential 2104 -> 2075
    // (-29): removed 29 = E3003 x12 (Rent:374-378 + Workbench:68
    // select dereferences of `where`-narrowed members) + E3001 x9
    // (Rent:245-248 select unwraps, Rent:384-385 `points` cascade,
    // Feedback:212 published_at, Grant:324 decided_at,
    // Workbench:69 `previous` cascade) + E3005 x6 (Rent:374-376/378
    // flatten + Report:90 sum + Workbench:68 format overload
    // consequences of the same narrowing) + E3002 x2 (CRM:416/420
    // table-row arithmetic). Added 0: every other family is
    // bit-identical. Per-file nets equal whole-corpus nets per
    // file except Rent (-21 whole-corpus vs -19 table): the 2-site
    // gap is the L384/385 `points` cascade pair, which fires only
    // whole-corpus (single-file construct heads poison first with
    // E2001s, verified on both binaries). Differential isolated
    // without Git: a file-copy revert/rebuild toggle reproduces
    // the pinned baseline all-52 2104 exactly (identical family
    // histogram), and the restored tree reproduces 2075.
    // T35/R24 re-pin 2026-10-05 (payload id/version vs reserved
    // metadata in example headers: declared payload leaves shadow
    // same-spelled reserved metadata by resolved provenance): 1
    // file net-decrease (CanDesk), 51 unchanged, zero
    // net-increase; table total -1 (5047 -> 5046). Whole-corpus
    // (all-52) differential 2075 -> 2072 (-3): removed E5008 x3 =
    // Desk:139 `event.value.id` (declared `IncomingMail.id`,
    // CanDesk.can:17, via the same-file `Inbox.received` event) +
    // Propose:254 `event.result.version` and :289
    // `event.value.version` (declared
    // `ReservationOfferOutcome.version`, CanRent.can:110, via
    // `Rooms.accept_offer.completed` and `Rooms.offer_changed`).
    // Added 0: every other family is bit-identical. Retained
    // E5008 x2 = Report:110/:113 `run.parent` (bucket-a flip:
    // stored containment identity of `Run in Definition`,
    // correctly rejected — pinned by
    // t35r24_report_parent_stays_rejected). Per-file nets equal
    // whole-corpus nets per file except Propose (0 table vs -2
    // whole-corpus): single-file the `Rooms` owner is an
    // unresolvable external so the envelope stays opaque and the
    // conservative E5008s stand (verified on both binaries); Desk
    // resolves single-file (same-file owner). Differential
    // isolated without Git: /tmp dumps retained
    // (t35r24-base-corpus.json, t35r24-new-corpus.json).
    // T35/R23 re-pin 2026-10-05 (imported CRUD sequences resolve to
    // the canonical owner's exported operations: resolve registers
    // `{Importer}.{Model}.{op}` aliases gated on the owner's own
    // enabled-op registration): 52 files unchanged, zero table
    // movement; table total holds at 5046. Single-file the R23
    // owners are unresolvable externals (no `customer`/`todo`
    // provider in the file), so no alias registers and the table
    // reproduces 52/52 on both binaries. Whole-corpus (all-52)
    // differential 2072 -> 2066 (-6): removed E5006 x6, the only
    // E5006s corpus-wide (the family is now zero) = Mail:143
    // `Contact.update` + :152 `Contact.delete` (owner `customer`,
    // CanCustomer.can:74 full crud, model exported :18) +
    // Workbench:128 `Task.update` (owner `todo`, CanDo.can:55 full
    // crud, model exported :24) + same-class siblings Member:648
    // and Reception:148 `Contact.update` (plain `customer`
    // imports, CanMember.can:72 / CanReception.can:7) and
    // Workbench:162 `Task.update`. Added 0: every other family is
    // bit-identical. Disabled/absent/private/bound/ambiguous
    // boundaries pinned by t35r23_ tests (b4_check + b4_resolve).
    // Differential isolated without Git: /tmp dumps retained
    // (t35r23-base-corpus.json, t35r23-new-corpus.json).
    // T35/R25 re-pin 2026-10-06 (ICU select-branch literals are not
    // placeholders: `message_slots` parses complex-typed arguments
    // branch-aware under the accepted profile, so branch selectors
    // and literal body words no longer bind as slots): 1 file
    // net-decrease (CanEvent), 51 unchanged, zero net-increase;
    // table total -5 (5046 -> 5041). Whole-corpus (all-52)
    // differential 2066 -> 2061 (-5): removed E3016 x5, the only
    // E3016s corpus-wide (the family is now zero) = CanEvent:63
    // `notice_title` source `{Event}` + `nl` variant
    // `{Toegangsbewijs}`/`{Planning}`/`{Toegang}`/`{Wijziging}`.
    // Added 0: every other family is bit-identical (E5007 stays 0
    // corpus-wide; the structural stage is untouched). Per-file nets
    // equal whole-corpus nets per file (no harness gap). Unknown
    // placeholders (top-level, nested-in-branch, selector-arg,
    // variant) and malformed heads keep failing, pinned by
    // t35r25_ tests in b4_check. Differential isolated without
    // Git: /tmp dumps retained (t35r25-base-corpus.json,
    // t35r25-new-corpus.json); the base verifies byte-identical to
    // the R23 new dump.
    let table: &[(&str, usize)] = &[
        ("draft/CanAffiliate.can", 48),
        ("draft/CanApprove.can", 47),
        ("draft/CanBoard.can", 3),
        ("draft/CanBook.can", 161),
        ("draft/CanCRM.can", 144),
        ("draft/CanCatch.can", 57),
        ("draft/CanChat.can", 58),
        ("draft/CanCheck.can", 38),
        ("draft/CanContract.can", 25),
        ("draft/CanCreative.can", 71),
        ("draft/CanCustomer.can", 59),
        ("draft/CanDecide.can", 27),
        ("draft/CanDesk.can", 85),
        ("draft/CanDiscover.can", 85),
        ("draft/CanDo.can", 45),
        ("draft/CanEnrich.can", 19),
        ("draft/CanEvent.can", 311),
        ("draft/CanExpense.can", 95),
        ("draft/CanFeedback.can", 13),
        ("draft/CanField.can", 115),
        ("draft/CanGallery.can", 23),
        ("draft/CanGrant.can", 50),
        ("draft/CanHire.can", 126),
        ("draft/CanInbox.can", 100),
        ("draft/CanInvoice.can", 379),
        ("draft/CanKnowledge.can", 50),
        ("draft/CanLearn.can", 50),
        ("draft/CanLeave.can", 79),
        ("draft/CanLoyalty.can", 71),
        ("draft/CanMail.can", 149),
        ("draft/CanMaintain.can", 123),
        ("draft/CanMember.can", 338),
        ("draft/CanOnboard.can", 55),
        ("draft/CanPropose.can", 135),
        ("draft/CanPurchase.can", 148),
        ("draft/CanReception.can", 190),
        ("draft/CanRefer.can", 79),
        ("draft/CanRent.can", 634),
        ("draft/CanReport.can", 45),
        ("draft/CanShift.can", 191),
        ("draft/CanStats.can", 35),
        ("draft/CanStock.can", 60),
        ("draft/CanSuccess.can", 50),
        ("draft/CanSync.can", 19),
        ("draft/CanTable.can", 33),
        ("draft/CanTime.can", 126),
        ("draft/CanTrade.can", 18),
        ("draft/CanVolunteer.can", 76),
        ("draft/CanWorkbench.can", 84),
        ("draft/shared/Employees.can", 8),
        ("draft/shared/Locations.can", 5),
        ("draft/shared/Suppliers.can", 6),
    ];
    let root = workspace_root();
    let mut mismatches = Vec::new();
    let mut actual_table = Vec::new();
    let mut undocumented = BTreeSet::new();
    for (file, expected) in table {
        let src = std::fs::read_to_string(root.join(file)).unwrap();
        let diags = check(&src, Some(&catalog));
        actual_table.push(format!("(\"{file}\", {}),", diags.len()));
        if diags.len() != *expected {
            mismatches.push(format!("{file}: expected {expected}, got {}", diags.len()));
        }
        for d in &diags {
            if explain::lookup(d.code).is_none() {
                undocumented.insert(d.code.to_string());
            }
        }
    }
    assert!(
        undocumented.is_empty(),
        "undocumented codes: {undocumented:?}"
    );
    assert!(
        mismatches.is_empty(),
        "draft table moved:\n{}\nactual table:\n{}",
        mismatches.join("\n"),
        actual_table.join("\n")
    );
}

/// Message calls against the real catalog: the message overload
/// resolves a declared message plus locale, and rejects mistyped
/// locale arguments with the precise no-match shape.
#[test]
fn message_calls_against_real_catalog() {
    let Some(path) = real_catalog_path() else {
        eprintln!("SKIP message_calls_against_real_catalog: no packages/values/dist/catalog.json");
        return;
    };
    let catalog = load_real_catalog(&path);
    assert_clean(
        "app T\nGiven\n message m = \"Hi {name}\"@{}\nWhen\n scenario s() by=members\n  do\n   let x = format(m, locale=null)\nThen\n",
        Some(&catalog),
    );
    assert_clean(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   let x = format(\"Hi {n}\", {n=\"Bo\"})\nThen\n",
        Some(&catalog),
    );
    let src = "app T\nGiven\n message m = \"Hi\"@{}\nWhen\n scenario s() by=members\n  do\n   let x = format(m, locale=42)\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E3005", "format(m, locale=42)", 1)]);
    assert!(
        diags[0].message.contains("(message m, int)"),
        "{}",
        diags[0].message
    );
}

#[test]
fn real_catalog_end_to_end() {
    let Some(path) = real_catalog_path() else {
        eprintln!("SKIP real_catalog_end_to_end: no packages/values/dist/catalog.json");
        return;
    };
    let catalog = load_real_catalog(&path);
    // Core builtins the examples rely on resolve with shapes.
    for id in [
        "count", "sum", "min", "max", "trim", "first", "action", "money",
    ] {
        assert!(catalog.lookup(id).is_some(), "missing builtin {id}");
    }
    assert_eq!(
        catalog.availability("sum"),
        Some(canlang_compiler::analysis::catalog::Availability::Implemented)
    );
    // `sum` flipped planned→implemented with lane-02 PR5 (stdlib-pure
    // dispatchers); the pin fails if it ever flips back. Every
    // implemented builtin carries at least one overload.
    for id in catalog.ids() {
        let entry = catalog.lookup(id).unwrap();
        if entry.kind == canlang_compiler::analysis::catalog::EntryKind::Builtin
            && catalog.availability(id)
                != Some(canlang_compiler::analysis::catalog::Availability::Planned)
        {
            assert!(!entry.overloads.is_empty(), "builtin {id} has no overloads");
        }
    }
}

fn argv(words: &[&str]) -> Vec<String> {
    std::iter::once("can")
        .chain(words.iter().copied())
        .map(str::to_string)
        .collect()
}

#[test]
fn cli_catalog_flag_forms() {
    let dir = scratch_dir();
    let catalog_path = write_file(&dir, "catalog.json", FIXTURE_JSON);
    // The source depends on the catalog: only the flag makes it clean.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n derive ok(): int = count(Todo)\nWhen\nThen\n";
    let file = write_file(&dir, "main.can", src);
    let flag = catalog_path.to_string_lossy().into_owned();
    for args in [
        argv(&[
            "check",
            "--format=json",
            "--catalog",
            &flag,
            &file.to_string_lossy(),
        ]),
        argv(&[
            "check",
            &format!("--catalog={flag}"),
            "--format=json",
            &file.to_string_lossy(),
        ]),
    ] {
        let result = dispatch(&args);
        assert_eq!(
            result.code, 0,
            "stdout: {}, stderr: {}",
            result.stdout, result.stderr
        );
        assert!(result.stderr.is_empty());
        assert!(
            result.stdout.contains("\"complete\":true"),
            "{}",
            result.stdout
        );
        assert!(
            result.stdout.contains("\"diagnostics\":[]"),
            "{}",
            result.stdout
        );
    }
}

#[test]
fn cli_catalog_flag_rejections() {
    // `--catalog` is rejected (never silently ignored) where it is inert.
    for args in [
        argv(&["explain", "--catalog=x", "E2001"]),
        argv(&["fmt", "--catalog=x", "a.can"]),
        argv(&["lsp", "--catalog=x"]),
        argv(&["--catalog", "x", "run"]),
        argv(&["check", "--catalog"]),
    ] {
        let result = dispatch(&args);
        assert_eq!(
            result.code, 2,
            "{args:?}: {}{}",
            result.stdout, result.stderr
        );
        assert!(result.stdout.is_empty(), "{args:?}: {}", result.stdout);
        assert!(
            result.stderr.contains("E7001"),
            "{args:?}: {}",
            result.stderr
        );
    }
}

#[test]
fn cli_real_pipeline_exit_codes_and_discipline() {
    let dir = scratch_dir();
    let catalog_path = write_file(&dir, "catalog.json", FIXTURE_JSON);
    let analyzer = CatalogAnalyzer::new(Some(catalog_path), None, dir.clone());
    // Error source: exit 10, JSON single-line envelope, empty stderr.
    let bad = write_file(
        &dir,
        "bad.can",
        "app T\nGiven\n derive bad(): int = 99999999999999999999\nWhen\nThen\n",
    );
    let result = dispatch_with(
        &argv(&["check", "--format=json", &bad.to_string_lossy()]),
        &analyzer,
    );
    assert_eq!(result.code, 10);
    assert!(result.stderr.is_empty());
    let line = result.stdout.trim_end();
    assert!(!line.contains('\n'), "single-line JSON");
    for field in [
        "\"tool\":\"can\"",
        "\"complete\":true",
        "\"code\":\"E3001\"",
        "\"severity\":\"error\"",
        "bad.can",
    ] {
        assert!(line.contains(field), "missing {field}: {line}");
    }
    // Text form: path:line:col locations; complete analysis shows no
    // incomplete note.
    let result = dispatch_with(&argv(&["check", &bad.to_string_lossy()]), &analyzer);
    assert_eq!(result.code, 10);
    assert!(result.stderr.is_empty());
    assert!(result.stdout.contains("bad.can:3:"), "{}", result.stdout);
    assert!(result.stdout.contains("error E3001"), "{}", result.stdout);
    assert!(
        !result.stdout.contains("note: analysis incomplete"),
        "{}",
        result.stdout
    );
    // Missing catalog through the seam: precise E6002 naming every spot.
    let missing = CatalogAnalyzer::new(
        Some(dir.join("no-such-catalog.json")),
        None,
        dir.join("empty-cwd"),
    );
    std::fs::create_dir_all(dir.join("empty-cwd")).unwrap();
    let good = write_file(&dir, "good.can", "app T\nGiven\nWhen\nThen\n");
    let result = dispatch_with(&argv(&["check", &good.to_string_lossy()]), &missing);
    assert_eq!(result.code, 10, "{}", result.stdout);
    for needle in [
        "E6002",
        "no-such-catalog.json",
        "CAN_CATALOG",
        "can-catalog.json",
        "packages/values/dist/catalog.json",
        "npm run catalog",
    ] {
        assert!(
            result.stdout.contains(needle),
            "missing {needle}: {}",
            result.stdout
        );
    }
    // An empty database never panics the analyzer; the pipeline runs
    // vacuously, so the result is complete.
    let db = SourceDb::new();
    let result = missing.analyze(&db, "test");
    assert!(result.complete);
}

/// Explicitly test-only lane-05-shaped fixture: synthetic ids no producer
/// emits, one leaf and one slotted group exercising every extras field.
const L5_FIXTURE_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-l5-0",
  "entries": [
    {"id": "test_widget_alpha", "js": "testWidgetAlpha", "owner": "test", "kind": "component", "signature": "testWidgetAlpha(props: TestAlphaProps)", "availability": "implemented", "profile": "leaf", "header": "text", "attributes": ["tone", "max"], "notes": "synthetic leaf"},
    {"id": "test_widget_beta", "js": "testWidgetBeta", "owner": "test", "kind": "component", "signature": "testWidgetBeta(props: TestBetaProps)", "availability": "planned", "profile": "slotted-group", "header": "value", "attributes": ["open"], "slots": [{"name": "items", "required": true, "repeatable": true}, {"name": "empty", "required": false, "repeatable": false}], "alternates": ["group"]}
  ]
}"#;

#[test]
fn lane05_component_shape() {
    use canlang_compiler::analysis::catalog::{Availability, EntryKind};
    let (catalog, diags) = load_json_catalog(L5_FIXTURE_JSON);
    assert!(diags.is_empty(), "{diags:?}");
    let catalog = catalog.expect("component catalog");
    assert_eq!(catalog.version(), "test-only-l5-0");
    assert_eq!(catalog.ids().count(), 2);
    for id in ["test_widget_alpha", "test_widget_beta"] {
        let entry = catalog.lookup(id).unwrap_or_else(|| panic!("{id}"));
        assert_eq!(entry.kind, EntryKind::Component);
        assert!(
            entry.overloads.is_empty(),
            "no overload parse for components"
        );
        assert!(entry.effects.is_none(), "components carry no effects");
        assert!(!catalog.is_builtin(id));
        assert!(catalog.is_component(id));
    }
    assert_eq!(
        catalog.availability("test_widget_beta"),
        Some(Availability::Planned)
    );
    let alpha = catalog.component("test_widget_alpha").unwrap();
    assert_eq!(alpha.profile, "leaf");
    assert_eq!(alpha.header, "text");
    assert_eq!(
        alpha.attributes,
        vec!["tone".to_string(), "max".to_string()]
    );
    assert!(alpha.slots.is_empty());
    assert!(alpha.alternates.is_empty());
    let beta = catalog.component("test_widget_beta").unwrap();
    assert_eq!(beta.profile, "slotted-group");
    assert_eq!(beta.header, "value");
    assert_eq!(beta.attributes, vec!["open".to_string()]);
    assert_eq!(beta.slots.len(), 2);
    assert_eq!(beta.slots[0].name, "items");
    assert!(beta.slots[0].required && beta.slots[0].repeatable);
    assert_eq!(beta.slots[1].name, "empty");
    assert!(!beta.slots[1].required && !beta.slots[1].repeatable);
    assert_eq!(beta.alternates, vec!["group".to_string()]);
    // Components are recorded, never source-callable: a source
    // reference is an ordinary E2001, and the id stays declarable.
    assert_findings(
        "app T\nGiven\n derive bad(): int = test_widget_alpha\nWhen\nThen\n",
        &check(
            "app T\nGiven\n derive bad(): int = test_widget_alpha\nWhen\nThen\n",
            Some(&catalog),
        ),
        &[("E2001", "test_widget_alpha", 1)],
    );
    assert_clean(
        "app T\nGiven\n test_widget_alpha { x:int }\nWhen\nThen\n",
        Some(&catalog),
    );
}

#[test]
fn lane05_component_shape_gaps() {
    // Components must not carry effects; profile/header come from fixed
    // vocabularies; extras must be well-shaped. Each is E6003.
    let base = |entry: &str| {
        format!("{{\"language_version\":\"1.0\",\"catalog_version\":\"t\",\"entries\":[{entry}]}}")
    };
    let good = |extra: &str| {
        format!(
            "{{\"id\":\"w\",\"js\":\"w\",\"owner\":\"t\",\"kind\":\"component\",\"signature\":\"w(props)\",\"availability\":\"implemented\",\"profile\":\"leaf\",\"header\":\"text\"{extra}}}"
        )
    };
    for (name, entry) in [
        ("effects", good(",\"effects\":\"pure\"")),
        ("profile", good("").replace("\"profile\":\"leaf\"", "\"profile\":\"orb\"")),
        ("header", good("").replace("\"header\":\"text\"", "\"header\":\"vibes\"")),
        ("missing-profile", "{\"id\":\"w\",\"js\":\"w\",\"owner\":\"t\",\"kind\":\"component\",\"signature\":\"w(props)\",\"availability\":\"implemented\",\"header\":\"text\"}".to_string()),
        ("attributes-shape", good(",\"attributes\":\"tone\"")),
        ("attributes-item", good(",\"attributes\":[\"tone\",7]")),
        ("slots-shape", good(",\"slots\":{\"items\":true}")),
        ("slot-field", good(",\"slots\":[{\"name\":\"items\",\"required\":true}]")),
        ("alternates-item", good(",\"alternates\":[\"orb\"]")),
        ("empty-signature", good("").replace("\"signature\":\"w(props)\"", "\"signature\":\"  \"")),
    ] {
        let (catalog, diags) = load_json_catalog(&base(&entry));
        assert!(catalog.is_none(), "{name}: {catalog:?}");
        assert_eq!(diags.len(), 1, "{name}: {diags:?}");
        assert_eq!(diags[0].code, "E6003", "{name}: {diags:?}");
    }
}

/// B2: `invocation()` takes the COMPLETE normalized input schema of its
/// target (DESIGN §2.2), not `action()`'s record-only bindings.
#[test]
fn invocation_constructor_complete_inputs() {
    let catalog = fixture();
    let given = "app T\nGiven\n Todo { title:text, pr:enum(low,high)=low }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title,pr\n scenario worker(t:Todo, note:text) by=members\n  do\n   let x = 1\n";
    // Complete scenario inputs, the Workbench `record`+`changes` update
    // shape, and a bare enum case inside `changes` all check clean.
    assert_clean(
        &format!(
            "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(worker, {{t=t, note=\"hi\"}})\n   let w = invocation(Todo.update, {{record=t, changes={{title=\"x\"}}}})\n   let e = invocation(Todo.update, {{record=t, changes={{pr=high}}}})\nThen\n"
        ),
        Some(&catalog),
    );
    // A missing required non-record input is E3005, spanning the call.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(worker, {{t=t}})\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[("E3005", "invocation(worker, {t=t})", 1)],
    );
    // Unknown inputs are E3005 too.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(worker, {{t=t, note=\"hi\", bogus=1}})\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[(
            "E3005",
            "invocation(worker, {t=t, note=\"hi\", bogus=1})",
            1,
        )],
    );
    // `action()`'s record-only shape is incomplete here: update needs
    // its `changes` as well.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(Todo.update, {{record=t}})\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[("E3005", "invocation(Todo.update, {record=t})", 1)],
    );
    // Non-object arguments never match.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(worker, 42)\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[("E3005", "invocation(worker, 42)", 1)],
    );
}

/// B3: `invocation()` values are a closed complete-call type distinct
/// from `action`; `call value {}` carries no replacement arguments.
#[test]
fn invocation_result_type_and_call() {
    let catalog = fixture();
    let given = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\n";
    // `call v {}` on a complete invocation value checks clean.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(Todo.update, {{record=t, changes={{title=\"x\"}}}})\n   call v {{}}\nThen\n"
    );
    assert_clean(&src, Some(&catalog));
    // Any supplied argument is E3009 on its key.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(Todo.update, {{record=t, changes={{title=\"x\"}}}})\n   call v {{title=\"y\"}}\nThen\n"
    );
    let diags = check(&src, Some(&catalog));
    assert_findings(&src, &diags, &[("E3009", "title", 4)]);
    assert!(
        diags[0].message.contains("complete arguments"),
        "{}",
        diags[0].message
    );
    // Invocation values are not actions: passing one where an action
    // is expected is E3001, spanning the supplied value.
    let src = format!(
        "{given} scenario takes(a:action(Todo.update)) by=members\n  do\n   let x = 1\n scenario caller(t:Todo) by=members\n  do\n   call takes {{a=invocation(Todo.update, {{record=t, changes={{title=\"x\"}}}})}}\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[(
            "E3001",
            "invocation(Todo.update, {record=t, changes={title=\"x\"}})",
            1,
        )],
    );
    // And action values are not invocations.
    let src = format!(
        "{given} scenario takesv(vv:invocation(Todo.update)) by=members\n  do\n   let x = 1\n scenario caller(t:Todo) by=members\n  do\n   call takesv {{vv=action(Todo.update, {{record=t}})}}\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[("E3001", "action(Todo.update, {record=t})", 1)],
    );
}

/// B4: `invocation(...)` in type position is a nonempty distinct closed
/// set of local enabled user mutation targets (CanWorkbench.can:15).
#[test]
fn invocation_type_position() {
    let catalog = fixture();
    // The Workbench witness shape checks clean.
    assert_clean(
        "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n export contract Proposal {summary:text, call:invocation(Todo.update,worker)?}\nWhen\n crud Todo by=members fields=title\n scenario worker(t:Todo, note:text) by=members\n  do\n   let x = 1\nThen\n",
        Some(&catalog),
    );
    // A read scenario is not a mutation target.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n export contract Proposal {summary:text, call:invocation(reader)?}\nWhen\n crud Todo by=members fields=title\n scenario reader(t:Todo) read=true by=members -> int\n  do\n   return 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E3009", "reader", 1)]);
    assert!(diags[0].message.contains("read"), "{}", diags[0].message);
    // Duplicate targets are E3009 on the repeat.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n export contract Proposal {summary:text, call:invocation(worker,worker)}\nWhen\n crud Todo by=members fields=title\n scenario worker(t:Todo, note:text) by=members\n  do\n   let x = 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E3009", "worker", 2)]);
    assert!(
        diags[0].message.contains("duplicate"),
        "{}",
        diags[0].message
    );
    // A model is not a mutation target.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n export contract Proposal {summary:text, call:invocation(Todo)}\nWhen\n crud Todo by=members fields=title\nThen\n";
    assert_findings(src, &check(src, Some(&catalog)), &[("E3009", "Todo", 3)]);
}

/// B5: read scenarios are not action/invocation targets anywhere.
#[test]
fn read_scenarios_rejected_as_action_targets() {
    let catalog = fixture();
    let given = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\n scenario reader(t:Todo) read=true by=members -> int\n  do\n   return 1\n";
    // `action()` over a read scenario is E3005.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let a = action(reader, {{t=t}})\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[("E3005", "action(reader, {t=t})", 1)],
    );
    // `invocation()` over a read scenario is E3005.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let v = invocation(reader, {{t=t}})\nThen\n"
    );
    assert_findings(
        &src,
        &check(&src, Some(&catalog)),
        &[("E3005", "invocation(reader, {t=t})", 1)],
    );
    // `action(...)` in type position over a read scenario is E3009.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n export contract C {a:action(reader)}\nWhen\n crud Todo by=members fields=title\n scenario reader(t:Todo) read=true by=members -> int\n  do\n   return 1\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E3009", "reader", 1)]);
    assert!(diags[0].message.contains("read"), "{}", diags[0].message);
}

/// M6: `slot`/`preferences`/catalog-item subtrees resolve and type like
/// their siblings; positional catalog domains are expressions.
/// Catalog `NAME=word` options stay silent: words are PR5 membership
/// work (a word is not a name reference), pinned here deliberately.
/// M6 extension (PR6): bare-word catalog headers (`input title`) are
/// field-selector vocabulary, not references — silent until
/// per-component header profiles land (no producer UI catalog exists
/// yet). Core leafs (`text`) stay strict, and complex catalog
/// expressions (calls, member paths) still resolve.
#[test]
fn ui_transparent_groups_resolve() {
    let catalog = fixture();
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\nThen\n page /t title=\"T\"\n  modal \"M\" id=dlg\n   slot content\n    text nosuchvar\n  badge nosuchvar2\n  badge count(nosuchvar3)\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E2001", "nosuchvar", 1), ("E2001", "nosuchvar3", 1)],
    );
    // Option words are catalog vocabulary, not references: silent.
    assert_clean(
        "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\nThen\n page /t title=\"T\"\n  badge \"x\" tone=primary\n",
        Some(&catalog),
    );
    // Bare-word catalog headers are field-selector vocabulary: silent.
    assert_clean(
        "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\nThen\n page /t title=\"T\"\n  card \"C\"\n   input title\n",
        Some(&catalog),
    );
}

/// PR6: `row` in UI collections types from the domain model, so
/// enum cases claim in collection children (`require row.status==x`)
/// exactly like scenario guards. Unknown cases still E2001.
#[test]
fn ui_row_enum_cases_claim() {
    let catalog = fixture();
    let given = "app T\nGiven\n Expense { status:enum(draft,submitted)=draft }\n policy Expense read=members\nWhen\nThen\n page / title=\"E\"\n  card \"C\"\n   list Expense\n";
    assert_clean(
        &format!("{given}    alert\n     require row.status==draft\n     text row.status\n"),
        Some(&catalog),
    );
    let bad = format!("{given}    alert\n     require row.status==nosuchcase\n");
    assert_findings(
        &bad,
        &check(&bad, Some(&catalog)),
        &[("E2001", "nosuchcase", 1)],
    );
}

/// M7: `call` on an action value reports missing required inputs that
/// were not pre-bound at construction.
#[test]
fn call_on_action_reports_missing() {
    let catalog = fixture();
    let given = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\n scenario worker(t:Todo, note:text) by=members\n  do\n   let x = 1\n";
    // The pre-bound record is satisfied; the missing note is E3009.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let a = action(worker, {{t=t}})\n   call a {{}}\nThen\n"
    );
    let diags = check(&src, Some(&catalog));
    assert_findings(&src, &diags, &[("E3009", "{}", 1)]);
    assert!(
        diags[0].message.contains("missing required input 'note'"),
        "{}",
        diags[0].message
    );
    // Supplying the remaining input checks clean.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let a = action(worker, {{t=t}})\n   call a {{note=\"x\"}}\nThen\n"
    );
    assert_clean(&src, Some(&catalog));
    // CRUD update actions still need their `changes` at the call.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let au = action(Todo.update, {{record=t}})\n   call au {{}}\nThen\n"
    );
    let diags = check(&src, Some(&catalog));
    assert_findings(&src, &diags, &[("E3009", "{}", 1)]);
    assert!(
        diags[0]
            .message
            .contains("missing required input 'changes'"),
        "{}",
        diags[0].message
    );
    // ... and supplying valid `changes` checks clean.
    let src = format!(
        "{given} scenario caller(t:Todo) by=members\n  do\n   let au = action(Todo.update, {{record=t}})\n   call au {{changes={{title=\"x\"}}}}\nThen\n"
    );
    assert_clean(&src, Some(&catalog));
}

/// M8: constructor binding failures are `E3005` (overload no-match),
/// not `E3009`; the entry must say so.
#[test]
fn e3009_entry_names_ctor_code() {
    let catalog = fixture();
    // The code path: a mistyped `action()` binding is E3005.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title\n scenario caller(t:Todo) by=members\n  do\n   let a = action(Todo.update, {record=t, bogus=1})\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E3005", "action(Todo.update, {record=t, bogus=1})", 1)],
    );
    // The entry text names the constructor code.
    let info = explain::lookup("E3009").expect("E3009 entry");
    assert!(
        info.explanation.contains("E3005"),
        "E3009 entry must name the constructor code: {}",
        info.explanation
    );
}

/// PR5B carryover (PR4 scope): the fixture `type=` list is DESIGN
/// §5's five samples, and quoted message locale keys validate.
#[test]
fn fixture_mime_and_quoted_locale_keys() {
    let catalog = fixture();
    // `application/json` is the fifth pinned sample (DESIGN §5).
    assert_clean(
        "app T\nGiven\n fixture f=file {type=\"application/json\"}\nWhen\nThen\n",
        Some(&catalog),
    );
    // Other types still reject.
    let src = "app T\nGiven\n fixture f=file {type=\"application/xml\"}\nWhen\nThen\n";
    assert_findings(
        src,
        &check(src, Some(&catalog)),
        &[("E3015", "\"application/xml\"", 1)],
    );
    // Quoted locale keys validate their tag, not an empty string.
    assert_clean(
        "app T\nGiven\n message m = \"Hi\"@{\"pt-BR\"=\"oi\"}\nWhen\nThen\n",
        Some(&catalog),
    );
    // ... and invalid quoted tags still report E3016 on the key.
    let src = "app T\nGiven\n message m = \"Hi\"@{\"toolongtagxx\"=\"oi\"}\nWhen\nThen\n";
    let diags = check(src, Some(&catalog));
    assert_findings(src, &diags, &[("E3016", "\"toolongtagxx\"", 1)]);
    assert!(
        diags[0].message.contains("toolongtagxx"),
        "{}",
        diags[0].message
    );
}
