//! Lint driver + first-rule tests: per-rule valid/invalid fixtures with
//! exact codes and spans, fix-contract tests, and a corpus noise run.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};

use canlang_compiler::analysis::catalog::CatalogRequest;
use canlang_compiler::analysis::{self, Catalog, CheckedProgram};
use canlang_compiler::diagnostic::{Diagnostic, Severity};
use canlang_compiler::lint::RULES;
use canlang_compiler::lint::driver::{
    DeprecatedSet, FixRejected, LintConfig, LintFix, RuleSet, apply_fix, apply_fixes,
    collect_fixes, lint_program,
};
use canlang_compiler::source::{SourceDb, SourceId, Span, sha256_hex};

fn check(
    text: impl AsRef<str>,
    catalog: Option<&Catalog>,
) -> (SourceDb, SourceId, CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("t.can".into(), text.as_ref().to_string());
    let (program, diags) = analysis::check_program(&db, &[id], catalog);
    (db, id, program, diags)
}

/// Lint `text` with `config`, checking against `catalog`.
fn run(
    text: impl AsRef<str>,
    catalog: Option<&Catalog>,
    config: &LintConfig,
) -> (SourceDb, SourceId, Vec<Diagnostic>) {
    let (db, id, program, _) = check(text.as_ref(), catalog);
    let diags = lint_program(&program, &db, config);
    (db, id, diags)
}

fn all() -> LintConfig {
    LintConfig {
        enabled: RuleSet::all(),
        fix: false,
        deprecated: None,
    }
}

fn with_deprecated(catalog: &Catalog) -> LintConfig {
    LintConfig {
        enabled: RuleSet::all(),
        fix: false,
        deprecated: Some(DeprecatedSet::from_catalog(catalog)),
    }
}

/// Byte span of the single occurrence of `needle` in `text`.
fn span_of(id: SourceId, text: impl AsRef<str>, needle: &str) -> Span {
    let text = text.as_ref();
    let start = text
        .find(needle)
        .unwrap_or_else(|| panic!("needle not found: {needle:?}")) as u32;
    Span::new(id, start, start + needle.len() as u32)
}

static CATALOG_SEQ: AtomicU32 = AtomicU32::new(0);

/// A minimal catalog with one deprecated builtin (`old_add`), one
/// plain builtin (`count`), and one deprecated helper (`old_help`,
/// which must never be treated as a deprecated *callable*).
fn test_catalog() -> Catalog {
    let json = r#"{
  "language_version": "1.0",
  "catalog_version": "lint-test-1",
  "entries": [
    {"id": "old_add", "js": "oldAdd", "owner": "lane-02", "kind": "builtin",
     "signature": "old_add(x:int)->int", "effects": "pure",
     "availability": "implemented", "deprecation": "use add instead"},
    {"id": "count", "js": "count", "owner": "lane-02", "kind": "builtin",
     "signature": "count(domain:C<T>)->int", "effects": "pure",
     "availability": "implemented"},
    {"id": "old_help", "js": "oldHelp", "owner": "lane-02", "kind": "helper",
     "signature": "old_help(x:int)->int", "effects": "pure",
     "availability": "implemented", "deprecation": "internal only"}
  ]
}"#;
    let seq = CATALOG_SEQ.fetch_add(1, Ordering::SeqCst);
    let path =
        std::env::temp_dir().join(format!("canlint-catalog-{}-{seq}.json", std::process::id()));
    std::fs::write(&path, json).unwrap();
    let cwd = std::env::temp_dir();
    let request = CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &cwd,
        primary: Span::new(SourceId(0), 0, 0),
    };
    let (catalog, diags) = canlang_compiler::analysis::catalog::load_catalog(&request);
    let _ = std::fs::remove_file(&path);
    assert!(diags.is_empty(), "test catalog must load: {diags:?}");
    catalog.expect("test catalog must load")
}

const PRELUDE: &str =
    "app T\nGiven\n Todo { title:text }\nWhen\n scenario s(task:Todo) by=members\n";

fn scenario(body: &str) -> String {
    format!("{PRELUDE}  do\n{body}Then\n")
}

/// Scenario with a declared result type (void scenarios cannot `return`
/// a value: E3001).
fn scenario_ret(ty: &str, body: &str) -> String {
    format!(
        "app T\nGiven\n Todo {{ title:text }}\nWhen\n scenario s(task:Todo) -> {ty} by=members\n  do\n{body}Then\n"
    )
}

// --- W3001 deprecated-builtin ------------------------------------------

#[test]
fn deprecated_warns_on_deprecated_call() {
    let catalog = test_catalog();
    let text = scenario_ret("int", "   let n=old_add(x=1)\n   return n\n");
    let (db, id, program, check_diags) = check(text.as_str(), Some(&catalog));
    assert!(
        check_diags.is_empty(),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &with_deprecated(&catalog));
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    let d = &diags[0];
    assert_eq!(d.code, "W3001");
    assert_eq!(d.severity, Severity::Warning);
    assert_eq!(d.primary, span_of(id, text.as_str(), "old_add"));
    assert!(d.message.contains("old_add"), "message: {}", d.message);
    assert!(
        d.message.contains("use add instead"),
        "message: {}",
        d.message
    );
}

#[test]
fn deprecated_silent_without_catalog_data() {
    let catalog = test_catalog();
    // The call still type-checks (catalog passed to the checker), but
    // the driver has no deprecation snapshot: report nothing, error nothing.
    let text = scenario_ret("int", "   let n=old_add(x=1)\n   return n\n");
    let (_, _, diags) = run(text.as_str(), Some(&catalog), &all());
    assert!(diags.is_empty(), "expected silence: {diags:?}");
    let (_, _, diags) = run(text.as_str(), Some(&catalog), &LintConfig::default());
    assert!(diags.is_empty(), "expected silence: {diags:?}");
}

#[test]
fn deprecated_ignores_shadowed_and_nonbuiltin() {
    let catalog = test_catalog();
    // A same-named local hides the builtin: the call is the checker's
    // business (E3005), never W3001.
    let text = scenario("   let old_add=1\n   let n=old_add\n   return n\n");
    let (_, _, diags) = run(text.as_str(), Some(&catalog), &with_deprecated(&catalog));
    assert!(
        diags.iter().all(|d| d.code != "W3001"),
        "shadowed call must not warn: {diags:?}"
    );
    // Helpers are not source-callable: excluded from the snapshot even
    // when the producer marks a notice.
    let snapshot = DeprecatedSet::from_catalog(&catalog);
    assert_eq!(snapshot.len(), 1);
    assert!(snapshot.notice("old_add").is_some());
    assert!(snapshot.notice("old_help").is_none());
    assert!(snapshot.notice("count").is_none());
}

// --- W1001 unreachable-statement -----------------------------------------

#[test]
fn unreachable_after_return_is_analysis_error_not_lint() {
    // Boundary pin: statements after `return` are the E4030 analysis
    // error; W1001 stands down and never duplicates the `E` code.
    let text = scenario_ret("Todo", "   let x=task\n   return x\n   let _dead=2\n");
    let (db, _, program, check_diags) = check(text.as_str(), None);
    assert!(
        check_diags.iter().any(|d| d.code == "E4030"),
        "E4030 must fire: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert!(
        diags.iter().all(|d| d.code != "W1001"),
        "no W1001 alongside E4030: {diags:?}"
    );
}

#[test]
fn unreachable_warns_after_require_false() {
    let text = scenario("   require false\n   set task {title=\"z\"}\n");
    let (_, id, diags) = run(text.as_str(), None, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    assert_eq!(diags[0].code, "W1001");
    assert_eq!(
        diags[0].primary,
        span_of(id, text.as_str(), "\n   set task {title=\"z\"}")
    );
}

#[test]
fn unreachable_valid_cases() {
    // Return last: nothing follows.
    let text = scenario_ret("Todo", "   let x=task\n   return x\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W1001"), "{diags:?}");
    // Ordinary require is not terminal.
    let text = scenario("   require task.title!=\"\"\n   set task {title=\"y\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W1001"), "{diags:?}");
    // Return inside a branch does not end the outer list.
    let text = scenario_ret(
        "Todo",
        "   if task.title!=\"\"\n    return task\n   set task {title=\"y\"}\n   return task\n",
    );
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W1001"), "{diags:?}");
    // `cancel` is not terminal.
    let text = scenario("   cancel \"k\"\n   set task {title=\"y\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W1001"), "{diags:?}");
}

#[test]
fn unreachable_require_false_semicolon_sequence_has_no_fix() {
    // `require false` keeps W1001 (E4030 covers `return` only); the
    // semicolon sequence still offers no removal fix (stranded `;`).
    let text = scenario("   require false; set task {title=\"z\"}\n");
    let (db, _, program, check_diags) = check(text.as_str(), None);
    assert!(
        check_diags.iter().all(|d| d.code != "E4030"),
        "E4030 must not cover require: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    assert_eq!(diags[0].code, "W1001");
    let config = LintConfig {
        enabled: RuleSet::all(),
        fix: true,
        deprecated: None,
    };
    let fixes = collect_fixes(&program, &db, &config);
    assert!(
        fixes.is_empty(),
        "semicolon-sequence removal would strand `;`: {fixes:?}"
    );
}

// --- I1001 unused-binding (`let`) ---------------------------------------

#[test]
fn unused_let_invalid() {
    let text = scenario("   let unused=1\n   set task {title=\"y\"}\n");
    let (db, id, program, check_diags) = check(text.as_str(), None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    let d = &diags[0];
    assert_eq!(d.code, "I1001");
    assert_eq!(d.severity, Severity::Info);
    assert_eq!(d.primary, span_of(id, text.as_str(), "unused"));
    // Removal is never offered: the initializer may fail.
    let config = LintConfig {
        enabled: RuleSet::all(),
        fix: true,
        deprecated: None,
    };
    assert!(collect_fixes(&program, &db, &config).is_empty());
}

#[test]
fn unused_let_valid_reads() {
    // Plain read.
    let text = scenario("   let x=task\n   set task {title=x.title}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
    // `{shorthand}` object entry reads the local.
    let text = scenario("   let title=\"t\"\n   create Todo {title} as row\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
    // `set` target path reads the local.
    let text = scenario("   let item2=task\n   set item2 {title=\"x\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
    // Underscore-prefixed names are intentionally-unused markers.
    let text = scenario("   let _tmp=1\n   set task {title=\"y\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
}

#[test]
fn unused_let_suppressed_by_shadowing() {
    // Two same-named bindings: attribution would be a guess, so the
    // conservative rule stays silent (and W2001 needs a nearby outer
    // read, which is absent too).
    let text = scenario(
        "   let dup=1\n   if task.title!=\"\"\n    let dup=2\n    set task {title=\"y\"}\n   set task {title=\"z\"}\n",
    );
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.is_empty(), "expected silence: {diags:?}");
}

// --- I1001 unused-binding (query alias) ----------------------------------

#[test]
fn unused_alias_invalid() {
    let text =
        scenario("   let _n=count(Todo as t where task.title!=\"\")\n   set task {title=\"y\"}\n");
    let (db, id, program, _) = check(text.as_str(), None);
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    assert_eq!(diags[0].code, "I1001");
    // The alias token is the `t` in `as t` (not the `t` in `Todo`/`task`).
    let start = text.find("as t").unwrap() as u32 + 3;
    assert_eq!(diags[0].primary, Span::new(id, start, start + 1));
}

#[test]
fn unused_alias_valid() {
    // Used in a following clause.
    let text =
        scenario("   let _n=count(Todo as t where t.title!=\"\")\n   set task {title=\"y\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
    // Used in the `any` second-argument scope.
    let text = scenario("   let _hit=any(Todo as t,t.title!=\"\")\n   set task {title=\"y\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
    // Underscore-prefixed aliases are intentionally-unused markers.
    let text =
        scenario("   let _n=count(Todo as _t where task.title!=\"\")\n   set task {title=\"y\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
}

#[test]
fn unused_alias_collection_descendant_scope() {
    // Read in a descendant: the collection alias stays visible to
    // descendants (DESIGN §3), so this must not warn.
    let text = "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page / title=\"T\"\n  list Todo as task where task.title!=\"\"\n   text task.title\n";
    let (db, _, program, check_diags) = check(text, None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert!(diags.iter().all(|d| d.code != "I1001"), "{diags:?}");
    // Unread anywhere including descendants: warn on the alias.
    let text = "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page / title=\"T\"\n  list Todo as task\n   text \"hi\"\n";
    let (db, id, program, check_diags) = check(text, None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    assert_eq!(diags[0].code, "I1001");
    let start = text.find("as task").unwrap() as u32 + 3;
    assert_eq!(diags[0].primary, Span::new(id, start, start + 4));
}

// --- W2001 shadowed-binding ----------------------------------------------

const SHADOW: &str = "   let user=task\n   if task.title!=\"x\"\n    let user=task\n    set user {title=\"y\"}\n   return user\n";

#[test]
fn shadow_warns_with_opt_in_only() {
    let text = scenario_ret("Todo", SHADOW);
    let (db, id, program, check_diags) = check(text.as_str(), None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    let d = &diags[0];
    assert_eq!(d.code, "W2001");
    assert_eq!(d.severity, Severity::Warning);
    // The inner binding: the second `user` in the source.
    let first = text.find("user").unwrap();
    let second = text[first + 1..].find("user").unwrap() + first + 1;
    assert_eq!(d.primary, Span::new(id, second as u32, second as u32 + 4));
    assert_eq!(d.related.len(), 1);
    assert_eq!(
        d.related[0].span,
        Span::new(id, first as u32, first as u32 + 4)
    );
    // Opt-in: recommended rules stay silent on the same fixture.
    let diags = lint_program(&program, &db, &LintConfig::default());
    assert!(diags.iter().all(|d| d.code != "W2001"), "{diags:?}");
}

#[test]
fn shadow_valid_cases() {
    // Outer binding never referenced nearby: suspicious-but-unproven.
    let text = scenario(
        "   let user=task\n   if task.title!=\"x\"\n    let user=task\n   set task {title=\"y\"}\n",
    );
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W2001"), "{diags:?}");
    // Disjoint suites are excluded.
    let text = scenario(
        "   if task.title!=\"x\"\n    let v=1\n    set task {title=\"y\"}\n   if task.title!=\"y\"\n    let v=2\n    set task {title=\"z\"}\n",
    );
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W2001"), "{diags:?}");
    // Contextual names are E2012 territory, never W2001 (the trailing
    // read would otherwise qualify as a nearby outer reference).
    let text = scenario(
        "   let row=task\n   if task.title!=\"x\"\n    let row=task\n   set task {title=row.title}\n",
    );
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W2001"), "{diags:?}");
    // Same-list duplicates are E2002, never W2001.
    let text = scenario("   let q=1\n   let q=2\n   set task {title=\"y\"}\n");
    let (_, _, diags) = run(text.as_str(), None, &all());
    assert!(diags.iter().all(|d| d.code != "W2001"), "{diags:?}");
}

// --- I1002 redundant-null-marker -----------------------------------------

#[test]
fn redundant_null_invalid() {
    let text = scenario_ret("text", "   let p=task?.title\n   return p\n");
    let (db, id, program, check_diags) = check(text.as_str(), None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    assert_eq!(diags[0].code, "I1002");
    assert_eq!(diags[0].severity, Severity::Info);
    assert_eq!(diags[0].primary, span_of(id, text.as_str(), "?."));
}

#[test]
fn redundant_null_valid_nullable_receiver() {
    let text = "app T\nGiven\n Todo { title:text, parent:Todo? }\nWhen\n scenario s(task:Todo) -> text? by=members\n  do\n   let p=task.parent?.title\n   return p\nThen\n";
    let (db, _, program, check_diags) = check(text, None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert!(diags.iter().all(|d| d.code != "I1002"), "{diags:?}");
    // And the plain `.` form on the same nullable receiver is the
    // checker's E3003, never the lint's business.
    let text = text.replace("?.", ".");
    let (_, _, _, check_diags) = check(text.as_str(), None);
    assert!(
        check_diags.iter().any(|d| d.code == "E3003"),
        "expected E3003, got: {check_diags:?}"
    );
}

// --- I1003/I1004 descriptions --------------------------------------------

#[test]
fn empty_description_invalid() {
    let text = "app T\nGiven\n #\n Todo { title:text }\nWhen\nThen\n";
    let (db, id, program, check_diags) = check(text, None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    assert_eq!(diags[0].code, "I1003");
    assert_eq!(diags[0].severity, Severity::Info);
    assert_eq!(diags[0].primary, span_of(id, text, "#"));
}

#[test]
fn description_valid_cases() {
    // Real prose: fine.
    let text = "app T\nGiven\n # Keep tasks.\n Todo { title:text }\nWhen\nThen\n";
    let (_, _, diags) = run(text, None, &all());
    assert!(diags.is_empty(), "{diags:?}");
    // Distinct adjacent descriptions: fine.
    let text = "app T\nGiven\n # Keep tasks.\n Todo { title:text }\n # Keep notes.\n Note { title:text }\nWhen\nThen\n";
    let (_, _, diags) = run(text, None, &all());
    assert!(diags.is_empty(), "{diags:?}");
    // Same prose separated by an undescribed declaration: not adjacent.
    let text = "app T\nGiven\n # Shared words.\n Todo { title:text }\n Note { title:text }\n # Shared words.\n Post { title:text }\nWhen\nThen\n";
    let (_, _, diags) = run(text, None, &all());
    assert!(diags.iter().all(|d| d.code != "I1004"), "{diags:?}");
    // Identical `#=` references: reuse is their purpose, never flagged.
    let text = "app T\nGiven\n #= msg.shared\n Todo { title:text }\n #= msg.shared\n Note { title:text }\nWhen\nThen\n";
    let (_, _, diags) = run(text, None, &all());
    assert!(diags.iter().all(|d| d.code != "I1004"), "{diags:?}");
}

#[test]
fn duplicate_description_invalid() {
    let text = "app T\nGiven\n # Same words.\n Todo { title:text }\n # Same words.\n Note { title:text }\nWhen\nThen\n";
    let (db, id, program, check_diags) = check(text, None);
    assert!(
        check_diags.iter().all(|d| d.code == "E6002"),
        "fixture must be otherwise clean: {check_diags:?}"
    );
    let diags = lint_program(&program, &db, &all());
    assert_eq!(diags.len(), 1, "expected one lint: {diags:?}");
    assert_eq!(diags[0].code, "I1004");
    assert_eq!(diags[0].severity, Severity::Info);
    let first = text.find("# Same words.").unwrap() as u32;
    let second = text[first as usize + 1..].find("# Same words.").unwrap() as u32 + first + 1;
    assert_eq!(
        diags[0].primary,
        Span::new(id, second, second + "# Same words.".len() as u32)
    );
    assert_eq!(diags[0].related.len(), 1);
    assert_eq!(
        diags[0].related[0].span,
        Span::new(id, first, first + "# Same words.".len() as u32)
    );
}

// --- Fix contract ----------------------------------------------------------

#[test]
fn fix_removes_unreachable_statement() {
    // `require false` carries W1001 (after-`return` is E4030, never lint).
    let text = scenario("   require false\n   let dead=2\n");
    let (db, _, program, _) = check(text.as_str(), None);
    let config = LintConfig {
        enabled: RuleSet::all(),
        fix: true,
        deprecated: None,
    };
    let fixes = collect_fixes(&program, &db, &config);
    assert_eq!(fixes.len(), 1, "{fixes:?}");
    let sha = sha256_hex(text.as_bytes());
    let fixed = apply_fix(&text, &sha, &fixes[0]).expect("safe fix applies");
    assert!(!fixed.contains("dead"), "fixed text:\n{fixed}");
    // The fixed source re-lints clean.
    let (_, _, diags) = run(fixed.as_str(), None, &all());
    assert!(diags.is_empty(), "{diags:?}");
}

#[test]
fn fix_narrows_redundant_safe_access() {
    let text = scenario_ret("text", "   let p=task?.title\n   return p\n");
    let (db, _, program, _) = check(text.as_str(), None);
    let config = LintConfig {
        enabled: RuleSet::all(),
        fix: true,
        deprecated: None,
    };
    let fixes = collect_fixes(&program, &db, &config);
    assert_eq!(fixes.len(), 1, "{fixes:?}");
    assert_eq!(fixes[0].replacement, ".");
    let sha = sha256_hex(text.as_bytes());
    let fixed = apply_fix(&text, &sha, &fixes[0]).expect("safe fix applies");
    assert!(fixed.contains("task.title"), "fixed text:\n{fixed}");
    let (_, _, diags) = run(fixed.as_str(), None, &all());
    assert!(diags.is_empty(), "{diags:?}");
}

#[test]
fn fix_flag_off_offers_nothing() {
    let text = scenario_ret("Todo", "   let x=task\n   return x\n   let dead=2\n");
    let (db, _, program, _) = check(text.as_str(), None);
    assert!(collect_fixes(&program, &db, &LintConfig::default()).is_empty());
    assert!(collect_fixes(&program, &db, &all()).is_empty());
}

#[test]
fn fix_refuses_stale_and_invalid() {
    // `require false` carries W1001 (after-`return` is E4030, never lint).
    let text = scenario("   require false\n   let dead=2\n");
    let (db, _, program, _) = check(text.as_str(), None);
    let config = LintConfig {
        enabled: RuleSet::all(),
        fix: true,
        deprecated: None,
    };
    let fixes = collect_fixes(&program, &db, &config);
    assert_eq!(fixes.len(), 1);
    let fix = &fixes[0];
    let sha = sha256_hex(text.as_bytes());
    // Stale: bytes changed since the fix was computed.
    let other = text.replace("dead", "live");
    let other_sha = sha256_hex(other.as_bytes());
    assert_eq!(
        apply_fix(&other, &other_sha, fix),
        Err(FixRejected::Stale {
            expected: sha.clone(),
            found: other_sha.clone(),
        })
    );
    // Batch application against changed bytes is refused as a whole.
    assert!(matches!(
        apply_fixes(&other, &other_sha, std::slice::from_ref(fix)),
        Err(FixRejected::Stale { .. })
    ));
    // Out-of-bounds span.
    let bad = LintFix {
        span: Span::new(SourceId(0), 10_000, 10_005),
        ..fix.clone()
    };
    assert!(matches!(
        apply_fix(&text, &sha, &bad),
        Err(FixRejected::SpanInvalid { .. })
    ));
    // Span splitting a character.
    let emoji = "app T ✓\n";
    let emoji_sha = sha256_hex(emoji.as_bytes());
    let split = LintFix {
        span: Span::new(SourceId(0), 6, 7),
        expected_sha256: emoji_sha.clone(),
        ..fix.clone()
    };
    assert!(matches!(
        apply_fix(emoji, &emoji_sha, &split),
        Err(FixRejected::SpanInvalid { .. })
    ));
    // Overlapping batch: the whole batch is rejected.
    let twin = fix.clone();
    assert!(matches!(
        apply_fixes(&text, &sha, &[fix.clone(), twin]),
        Err(FixRejected::Overlap { .. })
    ));
}

#[test]
fn fixes_apply_as_batch() {
    // `require false` carries W1001 (after-`return` is E4030, never lint).
    let text = scenario("   require false\n   let dead=2\n   set task {title=\"z\"}\n");
    let (db, _, program, _) = check(text.as_str(), None);
    let config = LintConfig {
        enabled: RuleSet::all(),
        fix: true,
        deprecated: None,
    };
    let fixes = collect_fixes(&program, &db, &config);
    assert_eq!(fixes.len(), 2, "{fixes:?}");
    let sha = sha256_hex(text.as_bytes());
    let fixed = apply_fixes(&text, &sha, &fixes).expect("batch applies");
    assert!(!fixed.contains("dead"), "fixed text:\n{fixed}");
    assert!(!fixed.contains("set task"), "fixed text:\n{fixed}");
    let (_, _, diags) = run(fixed.as_str(), None, &all());
    assert!(diags.is_empty(), "{diags:?}");
}

// --- Metadata --------------------------------------------------------------

#[test]
fn rule_table_is_consistent() {
    assert_eq!(RULES.len(), 7);
    let mut codes = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    for rule in RULES {
        assert!(codes.insert(rule.code), "duplicate code {}", rule.code);
        assert!(ids.insert(rule.id), "duplicate id {}", rule.id);
        assert_ne!(rule.severity, Severity::Error, "{}", rule.code);
        assert!(!rule.rationale.is_empty(), "{}", rule.code);
        assert!(!rule.basis.is_empty(), "{}", rule.code);
    }
}

#[test]
fn rule_codes_resolve_in_explain_catalog() {
    // Every shipped lint code must have a live `can explain` entry
    // with matching title/severity — no stale placeholders, no gaps.
    for rule in RULES {
        let info = canlang_compiler::explain::lookup(rule.code)
            .unwrap_or_else(|| panic!("{} has no explain entry", rule.code));
        assert_eq!(info.title, rule.title, "{}", rule.code);
        assert_eq!(info.severity, rule.severity, "{}", rule.code);
        assert!(
            !info.explanation.contains("not emitted in this build"),
            "{} explain is a stale placeholder",
            rule.code
        );
    }
}

#[test]
fn default_config_is_recommended_without_fixes_or_catalog() {
    let config = LintConfig::default();
    assert_eq!(config.enabled, RuleSet::recommended());
    assert!(!config.enabled.shadowing);
    assert!(config.enabled.unreachable_code);
    assert!(!config.fix);
    assert!(config.deprecated.is_none());
}

// --- Corpus noise assessment (informational) --------------------------------

#[test]
fn corpus_noise_assessment() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for dir in ["examples", "draft"] {
        let entries = std::fs::read_dir(root.join(dir)).unwrap();
        for entry in entries {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "can") {
                files.push(path);
            }
        }
    }
    files.sort();
    assert!(!files.is_empty(), "corpus must exist");
    let mut table: BTreeMap<String, BTreeMap<&str, usize>> = BTreeMap::new();
    for path in &files {
        let text = std::fs::read_to_string(path).unwrap();
        let mut db = SourceDb::new();
        let name = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let id = db.add(name.clone(), text.clone());
        let (program, _) = analysis::check_program(&db, &[id], None);
        let diags = lint_program(&program, &db, &all());
        for d in &diags {
            // Invariants (asserted): known codes, never Error, valid spans.
            assert!(
                RULES.iter().any(|rule| rule.code == d.code),
                "{name}: unknown code {}",
                d.code
            );
            assert_ne!(d.severity, Severity::Error, "{name}: {}", d.code);
            assert!(d.primary.start <= d.primary.end);
            assert!((d.primary.end as usize) <= text.len(), "{name}");
        }
        let row = table.entry(name).or_default();
        for d in &diags {
            *row.entry(d.code).or_insert(0) += 1;
        }
    }
    println!("corpus lint counts (informational; corpus need not be clean):");
    for (name, row) in &table {
        let total: usize = row.values().sum();
        println!("  {name}: total={total} {row:?}");
    }
}
