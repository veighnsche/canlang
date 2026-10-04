//! PR5B tests: the examples pass (`E5xxx`) and the check driver.
//!
//! Unit tests drive [`check_examples`] directly (catalog-free: example
//! semantics never depend on builtins) and assert exact `E5xxx` codes
//! plus needle-derived spans; other passes' diagnostics are filtered
//! out. Every case source must parse: an `E1xxx` fails the helper
//! rather than passing vacuously behind the error-skip. Behavior
//! tables pin the B1 evidence files E5xxx-clean, and the driver tests
//! pin dedup, ordering, the warning policy and the readiness gate.

use canlang_compiler::analysis::check::{
    CompleteInputs, dedup_diagnostics, exit_code, has_errors, readiness, sort_diagnostics,
};
use canlang_compiler::analysis::examples::{ERROR_CODES, ExampleTables, check_examples};
use canlang_compiler::analysis::{resolve, types};
use canlang_compiler::diagnostic::{Diagnostic, Severity};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::syntax;
use std::path::PathBuf;

/// Run parse + resolve + types + examples over one source.
fn run_examples(src: &str) -> (ExampleTables, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (tree, mut diags) = syntax::parse(&db, id);
    let trees = vec![(id, tree)];
    let resolve_tables = resolve::resolve_program(&db, &trees, None, &mut diags);
    let type_table = types::check_types(&db, &trees, None, &resolve_tables, &mut diags);
    resolve::emit_unresolved(&db, &resolve_tables, &type_table, &mut diags);
    let tables = check_examples(&db, &trees, &resolve_tables, &type_table, None, &mut diags);
    (tables, diags)
}

/// `E5xxx` diagnostics of one source; panics when it does not parse.
fn e5(src: &str) -> Vec<Diagnostic> {
    let (_, diags) = run_examples(src);
    assert!(
        diags.iter().all(|d| !d.code.starts_with("E1")),
        "case must parse, got {diags:?}\nsource:\n{src}"
    );
    diags
        .into_iter()
        .filter(|d| d.code.starts_with("E5"))
        .collect()
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

/// Assert exact `E5xxx` `(code, start, end)` findings; `expected`
/// entries are `(code, span needle, needle occurrence)`.
#[track_caller]
fn assert_e5(src: &str, expected: &[(&str, &str, usize)]) {
    let diags = e5(src);
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
    assert_eq!(got, want, "source:\n{src}\nall E5xxx: {diags:?}");
}

/// Assert one source is `E5xxx`-clean (other passes may still report).
#[track_caller]
fn assert_e5_clean(src: &str) {
    let diags = e5(src);
    assert!(
        diags.is_empty(),
        "expected E5xxx-clean, got {diags:?}\nsource:\n{src}"
    );
}

const MODEL: &str = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n";

const FIXTURE: &str = " fixture pending=Expense {amount=1}\n";

const SCENARIO: &str = "When\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n";

fn table_source(header_extra: &str, header: &str, rows: &str) -> String {
    format!(
        "{MODEL}{FIXTURE}{SCENARIO}  examples expense=pending{header_extra}\n   {header}\n{rows}Then\n"
    )
}

#[test]
fn error_code_vocabulary_is_closed() {
    assert_eq!(
        ERROR_CODES,
        [
            "validation",
            "forbidden",
            "not_found",
            "conflict",
            "rule_failed",
            "busy",
            "limit",
            "delivery_unknown",
        ]
    );
}

#[test]
fn unknown_binding_and_seed_shape() {
    // Unknown binding name; the valid `expense` binding keeps coverage.
    let src = table_source(
        " bogus=pending",
        "as -> expense.amount",
        "   members -> 1\n",
    );
    assert_e5(&src, &[("E5001", "bogus", 1)]);
    // `seed` takes a list, not one fixture.
    let src = table_source(" seed=pending", "as -> expense.amount", "   members -> 1\n");
    assert_e5(&src, &[("E5001", "pending", 3)]);
    // `seed` members must be fixtures; a model name is E5001.
    let src = table_source(
        " seed=[Expense]",
        "as -> expense.amount",
        "   members -> 1\n",
    );
    assert_e5(&src, &[("E5001", "Expense", 5)]);
    // Non-name seed members are E5001.
    let src = table_source(" seed=[1]", "as -> expense.amount", "   members -> 1\n");
    assert_e5(&src, &[("E5001", "1", 3)]);
    // Unresolvable seed names are resolve's E2001, never E5001.
    let src = table_source(" seed=[nope]", "as -> expense.amount", "   members -> 1\n");
    assert_e5_clean(&src);
    let (_, diags) = run_examples(&src);
    assert!(diags.iter().any(|d| d.code == "E2001"), "{diags:?}");
}

#[test]
fn seed_rejects_catalog_names() {
    // A builtin resolves (no E2001) yet is not a fixture: E5001.
    let dir = std::env::temp_dir().join(format!("canlang-pr5b-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("seed-catalog.json");
    std::fs::write(
        &path,
        r#"{"catalog_version":"test","language_version":"1.0","entries":[{"id":"count","kind":"builtin","signature":"count()->int","effects":"pure","availability":"implemented"}],"features":[]}"#,
    )
    .unwrap();
    let request = canlang_compiler::analysis::catalog::CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &dir,
        primary: Span::new(SourceId(0), 0, 0),
    };
    let (catalog, diags) = canlang_compiler::analysis::catalog::load_catalog(&request);
    assert!(diags.is_empty(), "{diags:?}");
    let catalog = catalog.expect("test catalog");
    let src = table_source(" seed=[count]", "as -> expense.amount", "   members -> 1\n");
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.clone());
    let (tree, mut diags) = syntax::parse(&db, id);
    let trees = vec![(id, tree)];
    let resolve_tables = resolve::resolve_program(&db, &trees, Some(&catalog), &mut diags);
    let type_table = types::check_types(&db, &trees, Some(&catalog), &resolve_tables, &mut diags);
    resolve::emit_unresolved(&db, &resolve_tables, &type_table, &mut diags);
    let _ = check_examples(
        &db,
        &trees,
        &resolve_tables,
        &type_table,
        Some(&catalog),
        &mut diags,
    );
    assert!(
        diags.iter().all(|d| d.code != "E2001"),
        "builtin must resolve: {diags:?}"
    );
    let (start, end) = span_of(&src, "count", 1);
    let hits: Vec<&Diagnostic> = diags.iter().filter(|d| d.code == "E5001").collect();
    assert_eq!(hits.len(), 1, "{diags:?}");
    assert_eq!((hits[0].primary.start, hits[0].primary.end), (start, end));
    std::fs::remove_file(&path).ok();
}

#[test]
fn missing_required_input() {
    let src = format!(
        "{MODEL}{FIXTURE}{SCENARIO}  examples\n   as -> expense.amount\n   members -> 1\nThen\n"
    );
    assert_e5(&src, &[("E5001", "examples", 1)]);
    // A row selector can supply the input instead of a binding.
    let src = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\nWhen\n scenario pick(amount:int) by=members\n  do\n   let x = 1\n  examples\n   amount -> amount\n   1 -> 1\nThen\n";
    assert_e5_clean(src);
}

#[test]
fn disabled_crud_operation_rejects_examples() {
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n fixture task=Todo {title=\"t\"}\nWhen\n crud Todo by=members fields=title delete=none\n  examples delete record=task\n   as,record.title -> record.title\n   members,\"t\" -> \"t\"\nThen\n";
    assert_e5(src, &[("E5001", "delete", 2)]);
}

#[test]
fn unknown_selectors() {
    // Unknown root.
    let src = table_source(
        "",
        "as,nope.status -> expense.amount",
        "   members,1 -> 1\n",
    );
    assert_e5(&src, &[("E5002", "nope.status", 1)]);
    // Unknown field; the span is the segment.
    let src = table_source(
        "",
        "as,expense.bogus -> expense.amount",
        "   members,1 -> 1\n",
    );
    assert_e5(&src, &[("E5002", "bogus", 1)]);
    // Non-selector input headers are E5002.
    let src = table_source("", "as,1 -> expense.amount", "   members,1 -> 1\n");
    assert_e5(&src, &[("E5002", "1", 3)]);
    // `result` is observable, not an input.
    let src = table_source("", "result -> expense.amount", "   1 -> 1\n");
    assert_e5(&src, &[("E5002", "result", 1)]);
    // Test accounts are values, not selectors.
    let src = table_source("", "other -> expense.amount", "   other -> 1\n");
    assert_e5(&src, &[("E5002", "other", 1)]);
    // `changes` outside a CRUD update is unknown.
    let src = table_source(
        "",
        "as,changes.amount -> expense.amount",
        "   members,1 -> 1\n",
    );
    assert_e5(&src, &[("E5002", "changes.amount", 1)]);
}

#[test]
fn observation_roots() {
    // Inputs are not observable.
    let src = table_source("", "as -> changes", "   members -> 1\n");
    assert_e5(&src, &[("E5002", "changes", 1)]);
    let src = table_source("", "as -> request", "   members -> 1\n");
    assert_e5(&src, &[("E5002", "request", 1)]);
    // `result` needs a declared result.
    let src = table_source("", "as -> result", "   members -> 1\n");
    assert_e5(&src, &[("E5002", "result", 1)]);
    // A read scenario may observe its result.
    let src = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\nWhen\n scenario summarize() read=true -> Total by=members\n  do\n   return Total {count=1}\n  examples\n   as -> result.count\n   members -> 1\nThen\n";
    assert_e5_clean(src);
}

#[test]
fn request_selectors() {
    // The sanctioned stale-version override stays clean.
    let src = table_source(
        "",
        "as,expense.amount,request.expense.version -> expense.amount",
        "   members,1,1 -> 1\n",
    );
    assert_e5_clean(&src);
    // Unknown request inputs and deeper envelopes are E5002.
    let src = table_source(
        "",
        "as,request.bogus -> expense.amount",
        "   members,1 -> 1\n",
    );
    assert_e5(&src, &[("E5002", "bogus", 1)]);
    let src = table_source(
        "",
        "as,request.expense.bogus -> expense.amount",
        "   members,1 -> 1\n",
    );
    assert_e5(&src, &[("E5002", "bogus", 1)]);
    let src = table_source("", "as,request -> expense.amount", "   members,1 -> 1\n");
    assert_e5(&src, &[("E5002", "request", 1)]);
}

#[test]
fn fixture_overrides() {
    // Reserved metadata can never be overridden by a selector ...
    let src = table_source(
        "",
        "as,expense.version -> expense.amount",
        "   members,1 -> 1\n",
    );
    assert_e5(&src, &[("E5008", "version", 1)]);
    // ... but version reads in observations are fine.
    let src = table_source("", "as -> expense.version", "   members -> 1\n");
    assert_e5_clean(&src);
    // User and file recipes are immutable.
    let src = format!(
        "{MODEL} fixture u=user {{}}\n fixture f=file {{}}\n{FIXTURE}{SCENARIO}  examples expense=pending\n   as,u.roles -> expense.amount\n   members,1 -> 1\nThen\n"
    );
    assert_e5(&src, &[("E5008", "u.roles", 1)]);
    let src = format!(
        "{MODEL} fixture u=user {{}}\n fixture f=file {{}}\n{FIXTURE}{SCENARIO}  examples expense=pending\n   as,f.type -> expense.amount\n   members,1 -> 1\nThen\n"
    );
    assert_e5(&src, &[("E5008", "f.type", 1)]);
}

#[test]
fn delivery_recipe_selectors() {
    let base = format!("{MODEL}{FIXTURE}{SCENARIO}");
    // Whole status/result/error selections are legal ...
    let src = format!(
        "{base}  examples expense=pending\n   as -> expense.amount\n   members -> 1\nThen\n"
    );
    assert_e5_clean(&src);
    let recipe = " fixture a=approve {request={expense=pending}}\n";
    let src = format!(
        "{MODEL}{FIXTURE}{recipe}When\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as,a.status -> expense.amount\n   members,1 -> 1\nThen\n"
    );
    assert_e5_clean(&src);
    // ... descendant patches are not.
    let src = format!(
        "{MODEL}{FIXTURE}{recipe}When\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as,a.result.code -> expense.amount\n   members,1 -> 1\nThen\n"
    );
    assert_e5(&src, &[("E5008", "a.result.code", 1)]);
}

#[test]
fn overlapping_selectors() {
    // Exact duplicates.
    let src = table_source(
        "",
        "as,expense.amount,expense.amount -> expense.amount",
        "   members,1,1 -> 1\n",
    );
    assert_e5(&src, &[("E5003", "expense.amount", 2)]);
    // Whole value plus child.
    let src = table_source(
        "",
        "as,expense,expense.amount -> expense.amount",
        "   members,1,1 -> 1\n",
    );
    assert_e5(&src, &[("E5003", "expense.amount", 1)]);
    // The same seeded record through two spellings.
    let src = table_source(
        "",
        "as,expense.amount,pending.amount -> expense.amount",
        "   members,1,1 -> 1\n",
    );
    assert_e5(&src, &[("E5003", "pending.amount", 1)]);
    // `request.*` never conflicts with state ...
    let src = table_source(
        "",
        "as,expense.amount,request.expense.version -> expense.amount",
        "   members,1,1 -> 1\n",
    );
    assert_e5_clean(&src);
    // ... and `changes` never conflicts with `record`.
    let src = "app T\nGiven\n Todo { title:text, done:bool }\n policy Todo read=members\n fixture task=Todo {title=\"t\",done=false}\nWhen\n crud Todo by=members fields=title,done\n  examples update record=task\n   as,record.done,changes.done -> record.done\n   members,true,true -> true\nThen\n";
    assert_e5_clean(src);
}

#[test]
fn table_callers() {
    // Unknown callers, identities in role arrays, predicates.
    let src = table_source("", "as -> expense.amount", "   stranger -> 1\n");
    assert_e5(&src, &[("E5004", "stranger", 1)]);
    let src = table_source("", "as -> expense.amount", "   [owner,other] -> 1\n");
    assert_e5(&src, &[("E5004", "other", 1)]);
    let src = table_source("", "as -> expense.amount", "   authenticated -> 1\n");
    assert_e5(&src, &[("E5004", "authenticated", 1)]);
    // Model fixtures cannot select callers.
    let src = table_source("", "as -> expense.amount", "   pending -> 1\n");
    assert_e5(&src, &[("E5004", "pending", 3)]);
    // Non-name cells are rejected.
    let src = table_source("", "as -> expense.amount", "   1 -> 1\n");
    assert_e5(&src, &[("E5004", "1", 3)]);
    // The valid vocabulary stays clean.
    let src = format!(
        "{MODEL} fixture r=user {{roles=[owner]}}\n{FIXTURE}{SCENARIO}  examples expense=pending\n   as -> expense.amount\n   self -> 1\n   other -> 1\n   outsider -> 1\n   public -> 1\n   members -> 1\n   owner -> 1\n   r -> 1\n   [owner] -> 1\nThen\n"
    );
    assert_e5_clean(&src);
}

#[test]
fn parent_selectors() {
    // Navigation through a contained model's parent reads the
    // containing record ...
    let src = "app T\nGiven\n Todo { title:text }\n Note in Todo { text:text }\n policy Todo read=members\n policy Note read=members\nWhen\n scenario annotate(note:Note) by=members\n  do\n   let x = 1\n  examples note=scratch\n   as,note.parent.title -> note.text\n   members,\"t\" -> \"x\"\nThen\n";
    // (`scratch` is unbound: resolve's E2001, never an E5xxx.)
    let diags = e5(src);
    assert!(diags.is_empty(), "{diags:?}");
    // ... but the server-owned parent itself cannot be overridden.
    let src = "app T\nGiven\n Todo { title:text }\n Note in Todo { text:text }\n policy Todo read=members\n policy Note read=members\n fixture scratch=Note {text=\"x\"}\nWhen\n scenario annotate(note:Note) by=members\n  do\n   let x = 1\n  examples note=scratch\n   as,note.parent -> note.text\n   members,\"t\" -> \"x\"\nThen\n";
    assert_e5(src, &[("E5008", "parent", 1)]);
    // `parent` on a non-contained model is an unknown field.
    let src = table_source(
        "",
        "as,expense.parent -> expense.amount",
        "   members,1 -> 1\n",
    );
    assert_e5(&src, &[("E5002", "parent", 1)]);
}

#[test]
fn unresolved_imports_stay_quiet() {
    // Broken-import members are resolve's E2005; example checks do not
    // cascade onto them.
    let src = "app T\nuse employee {test_worker}\nGiven\n Expense { amount:int }\n policy Expense read=members\nWhen\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending seed=[test_worker]\n   as,test_worker.active -> expense.amount\n   test_worker,1 -> 1\nThen\n";
    let (_, diags) = run_examples(src);
    assert!(
        diags.iter().any(|d| d.code == "E2005"),
        "expected the broken import E2005: {diags:?}"
    );
    assert!(diags.iter().all(|d| !d.code.starts_with("E5")), "{diags:?}");
}

#[test]
fn trusted_handlers_take_no_as() {
    let src = "app T\nGiven\nWhen\n scenario tick on=every(5m)\n  do\n   let x = 1\n  examples\n   as -> x\n   members -> 1\nThen\n";
    let diags = e5(src);
    assert_eq!(
        diags.iter().map(|d| d.code).collect::<Vec<_>>(),
        vec!["E5004"],
        "{diags:?}"
    );
}

#[test]
fn expected_error_codes() {
    let src = table_source("", "as -> expense.amount", "   members -> error(bogus)\n");
    assert_e5(&src, &[("E5005", "bogus", 1)]);
    let rows = [
        "validation",
        "forbidden",
        "not_found",
        "conflict",
        "rule_failed",
        "busy",
        "limit",
        "delivery_unknown",
    ]
    .iter()
    .map(|c| format!("   members -> error({c})\n"))
    .collect::<String>();
    let src = table_source("", "as -> expense.amount", &rows);
    assert_e5_clean(&src);
    // `error()` never appears in an input cell.
    let src = table_source(
        "",
        "as,expense.amount -> expense.amount",
        "   members,error(rule_failed) -> 1\n",
    );
    assert_e5(&src, &[("E5002", "error(rule_failed)", 1)]);
}

const SEQ_MODEL: &str = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n fixture pending=Expense {amount=1}\nWhen\n";

fn sequence_source(scenarios: &str, steps: &str) -> String {
    format!("{SEQ_MODEL}{scenarios}  examples\n   do\n{steps}Then\n")
}

#[test]
fn sequences_call_their_enclosing_scenario() {
    // Approve's sequence only calls submit: the enclosing call is missing.
    let src = sequence_source(
        " scenario submit(expense:Expense) by=members\n  do\n   let x = 1\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n",
        "    call submit {expense=pending} by=self\n    expense.amount -> 1\n",
    );
    assert_e5(&src, &[("E5006", "examples", 1)]);
    // Calling the enclosing scenario (plus others) is clean.
    let src = sequence_source(
        " scenario submit(expense:Expense) by=members\n  do\n   let x = 1\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n",
        "    call submit {expense=pending} by=self\n    call approve {expense=pending} by=self\n    expense.amount -> 1\n",
    );
    assert_e5_clean(&src);
}

#[test]
fn sequence_call_targets() {
    let two = " scenario submit(expense:Expense) by=members\n  do\n   let x = 1\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n";
    // Unknown operations.
    let src = sequence_source(two, "    call nope {x=1} by=self\n    1 -> 1\n");
    assert_e5(&src, &[("E5006", "nope", 1), ("E5006", "examples", 1)]);
    // Trusted handlers cannot be invoked.
    let src = sequence_source(
        " scenario tick on=every(5m)\n  do\n   let x = 1\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n",
        "    call tick {} by=self\n    call approve {expense=pending} by=self\n    1 -> 1\n",
    );
    assert_e5(&src, &[("E5006", "tick", 2)]);
    // Non-operations cannot be invoked.
    let src = sequence_source(two, "    call Expense {amount=1} by=self\n    1 -> 1\n");
    assert_e5(&src, &[("E5006", "Expense", 6), ("E5006", "examples", 1)]);
    // Unknown models and CRUD verbs.
    let src = sequence_source(two, "    call Nope.create {amount=1} by=self\n    1 -> 1\n");
    assert_e5(
        &src,
        &[("E5006", "Nope.create", 1), ("E5006", "examples", 1)],
    );
    let src = sequence_source(
        two,
        "    call Expense.frobnicate {amount=1} by=self\n    1 -> 1\n",
    );
    assert_e5(
        &src,
        &[("E5006", "Expense.frobnicate", 1), ("E5006", "examples", 1)],
    );
    // Disabled CRUD operations.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n fixture task=Todo {title=\"t\"}\nWhen\n crud Todo by=members fields=title delete=none\n scenario approve(expense:Todo) by=members\n  do\n   let x = 1\n  examples\n   do\n    call Todo.delete {record=task} by=self\n    call approve {expense=task} by=self\n    1 -> 1\nThen\n";
    assert_e5(src, &[("E5006", "Todo.delete", 1)]);
    // Enabled CRUD calls are clean.
    let src = "app T\nGiven\n Todo { title:text }\n policy Todo read=members\n fixture task=Todo {title=\"t\"}\nWhen\n crud Todo by=members fields=title\n scenario approve(expense:Todo) by=members\n  do\n   let x = 1\n  examples\n   do\n    call Todo.update {record=task,changes={title=\"u\"}} by=self\n    call approve {expense=task} by=self\n    1 -> 1\nThen\n";
    assert_e5_clean(src);
}

#[test]
fn sequence_callers_arguments_and_envelopes() {
    let one = " scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n";
    // Roles are unavailable at sequence call sites.
    let src = format!(
        "app T\nGiven\n Expense {{ amount:int }}\n policy Expense read=members\n role reviewer label=\"R\"\n fixture pending=Expense {{amount=1}}\nWhen\n{one}  examples\n   do\n    call approve {{expense=pending}} by=reviewer\n    1 -> 1\nThen\n"
    );
    assert_e5(&src, &[("E5004", "reviewer", 2)]);
    // Unknown callers.
    let src = sequence_source(
        one,
        "    call approve {expense=pending} by=stranger\n    1 -> 1\n",
    );
    assert_e5(&src, &[("E5004", "stranger", 1)]);
    // Unknown and missing call inputs.
    let src = sequence_source(
        one,
        "    call approve {expense=pending,nope=1} by=self\n    1 -> 1\n",
    );
    assert_e5(&src, &[("E5006", "nope", 1)]);
    let src = sequence_source(one, "    call approve {} by=self\n    1 -> 1\n");
    assert_e5(&src, &[("E5006", "{}", 1)]);
    // Unknown request inputs and overrides.
    let src = sequence_source(
        one,
        "    call approve {expense=pending} by=self request={bogus={version=1}}\n    1 -> 1\n",
    );
    assert_e5(&src, &[("E5006", "bogus", 1)]);
    let src = sequence_source(
        one,
        "    call approve {expense=pending} by=self request={expense={bogus=1}}\n    1 -> 1\n",
    );
    assert_e5(&src, &[("E5006", "bogus", 1)]);
    // The sanctioned stale-version envelope stays clean.
    let src = sequence_source(
        one,
        "    let v = 1\n    call approve {expense=pending} by=self request={expense={version=v}} -> error(conflict)\n    1 -> 1\n",
    );
    assert_e5_clean(&src);
}

#[test]
fn sequence_bindings_and_results() {
    let one = " scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n";
    // Duplicate `let` bindings.
    let src = sequence_source(
        one,
        "    let v = 1\n    let v = 2\n    call approve {expense=pending} by=self\n    1 -> 1\n",
    );
    let diags = e5(&src);
    assert_eq!(diags.len(), 1, "{diags:?}");
    assert_eq!(diags[0].code, "E5006");
    assert!(
        diags[0].message.contains("duplicate"),
        "{}",
        diags[0].message
    );
    // `as` needs a declared result.
    let src = sequence_source(
        one,
        "    call approve {expense=pending} by=self as r\n    1 -> 1\n",
    );
    let diags = e5(&src);
    assert_eq!(diags.len(), 1, "{diags:?}");
    assert_eq!(diags[0].code, "E5006");
    assert!(
        diags[0].message.contains("declared result"),
        "{}",
        diags[0].message
    );
    // `result` needs a preceding successful result-bearing call.
    let src = sequence_source(
        one,
        "    result -> 1\n    call approve {expense=pending} by=self\n",
    );
    assert_e5(&src, &[("E5006", "result", 1)]);
    // A read scenario's result binds and observes cleanly.
    let src = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n contract Total { count:int }\nWhen\n scenario summarize() read=true -> Total by=members\n  do\n   return Total {count=1}\n  examples\n   do\n    call summarize {} by=self as t\n    t.count -> 1\nThen\n";
    assert_e5_clean(src);
}

fn message_source(decl: &str) -> String {
    format!("app T\nGiven\n message m{decl}\nWhen\nThen\n")
}

#[test]
fn icu_profile_violations() {
    // Missing `other`.
    let src = message_source("(n:int) = \"{n, plural, one {#}}\"@{}");
    assert_e5(&src, &[("E5007", "\"{n, plural, one {#}}\"", 1)]);
    // Duplicate branches.
    let src = message_source("(n:int) = \"{n, plural, one {#} one {#} other {#}}\"@{}");
    assert_e5(
        &src,
        &[("E5007", "\"{n, plural, one {#} one {#} other {#}}\"", 1)],
    );
    // Offsets are rejected.
    let src = message_source("(n:int) = \"{n, plural, offset:1, other {#}}\"@{}");
    assert_e5(
        &src,
        &[("E5007", "\"{n, plural, offset:1, other {#}}\"", 1)],
    );
    // Bad number/date styles.
    let src = message_source("(n:int) = \"{n,number,short}\"@{}");
    assert_e5(&src, &[("E5007", "\"{n,number,short}\"", 1)]);
    let src = message_source("(d:date) = \"{d,date,xx}\"@{}");
    assert_e5(&src, &[("E5007", "\"{d,date,xx}\"", 1)]);
    // Unbalanced patterns and stray `#`.
    let src = message_source(" = \"Hi {name\"@{}");
    assert_e5(&src, &[("E5007", "\"Hi {name\"", 1)]);
    let src = message_source(" = \"Hi }\"@{}");
    assert_e5(&src, &[("E5007", "\"Hi }\"", 1)]);
    let src = message_source(" = \"#\"@{}");
    assert_e5(&src, &[("E5007", "\"#\"", 1)]);
    // Unknown formats.
    let src = message_source("(n:int) = \"{n,choice,0 {x} other {y}}\"@{}");
    assert_e5(&src, &[("E5007", "\"{n,choice,0 {x} other {y}}\"", 1)]);
    // A bad variant is reported at the variant literal.
    let src = message_source("(n:int) = \"{n, plural, other {#}}\"@{nl=\"{n, plural, one {#}}\"}");
    assert_e5(&src, &[("E5007", "\"{n, plural, one {#}}\"", 1)]);
}

#[test]
fn icu_selector_types() {
    // Plural over text, select over int.
    let src = message_source("(n:text) = \"{n, plural, other {#}}\"@{}");
    assert_e5(&src, &[("E5007", "\"{n, plural, other {#}}\"", 1)]);
    let src = message_source("(n:int) = \"{n,select,a{x} other{y}}\"@{}");
    assert_e5(&src, &[("E5007", "\"{n,select,a{x} other{y}}\"", 1)]);
    // The valid profile stays clean, including the B1 plural shape.
    for template in [
        "\"no placeholders\"",
        "\"Hi {name}\"",
        "\"{n, plural, one {# task} other {# tasks}}\"",
        "\"{n, plural, =0 {none} other {#}}\"",
        "\"{n,number}\"",
        "\"{n,number,integer}\"",
        "\"{d,date}\"",
        "\"{d,time,short}\"",
        "\"{s,select,a{x} other{y}}\"",
        "\"it''s quoted\"",
        "\"'{not a slot}'\"",
    ] {
        let src = message_source(&format!("(n:int,d:date,s:text) = {template}@{{}}"));
        assert_e5_clean(&src);
    }
}

#[test]
fn message_signatures() {
    // Records and nullables are not message parameters.
    let src = "app T\nGiven\n Expense { amount:int }\n policy Expense read=members\n message m(e:Expense) = \"x\"@{}\nWhen\nThen\n";
    assert_e5(src, &[("E5009", "Expense", 3)]);
    let src = message_source("(n:int?) = \"x\"@{}");
    assert_e5(&src, &[("E5009", "int?", 1)]);
    // The scalar/enum vocabulary stays clean.
    let src = "app T\nGiven\n Expense { status:enum(a,b)=a }\n policy Expense read=members\n message m(a:int,b:text,c:bool,d:decimal,e:money,f:date,g:datetime,s:Expense.status) = \"x\"@{}\nWhen\nThen\n";
    assert_e5_clean(src);
}

#[test]
fn example_tables_carry_all_families() {
    let src = format!(
        "{MODEL}{FIXTURE}When\n scenario approve(expense:Expense) by=members\n  do\n   let x = 1\n  examples expense=pending\n   as -> expense.amount\n   members -> 1\n scenario submit(expense:Expense) by=members\n  do\n   let x = 1\n  examples\n   do\n    call submit {{expense=pending}} by=self\n    1 -> 1\nThen\n"
    );
    let (tables, diags) = run_examples(&src);
    assert!(
        diags.iter().all(|d| !d.code.starts_with("E1")),
        "case must parse: {diags:?}"
    );
    assert!(diags.iter().all(|d| !d.code.starts_with("E5")), "{diags:?}");
    assert_eq!(tables.fixtures.len(), 1, "{tables:?}");
    assert_eq!(tables.tables.len(), 1, "{tables:?}");
    assert_eq!(tables.sequences.len(), 1, "{tables:?}");
    let table = &tables.tables[0];
    assert_eq!(table.bindings, vec!["expense".to_string()]);
    assert_eq!(table.inputs, vec!["as".to_string()]);
    assert_eq!(table.observations, vec!["expense.amount".to_string()]);
    assert_eq!(table.rows, 1);
    assert!(table.operation.is_some());
    let sequence = &tables.sequences[0];
    assert_eq!(sequence.calls.len(), 1);
    assert!(sequence.calls[0].target.is_some());
    assert_eq!(sequence.calls[0].caller, "self");
    assert!(!sequence.calls[0].expects_error);
    assert_eq!(sequence.assertions, 1);
    assert!(sequence.operation.is_some());
}

fn workspace_examples() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("examples")
}

#[test]
fn shipped_examples_are_e5xxx_clean() {
    let dir = workspace_examples();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "can"))
        .collect();
    files.sort();
    assert!(
        files.iter().any(|p| p.ends_with("TeamTasks.can")),
        "TeamTasks.can missing from {files:?}"
    );
    assert!(
        files.iter().any(|p| p.ends_with("ExpenseFlow.can")),
        "ExpenseFlow.can missing from {files:?}"
    );
    for path in &files {
        let src = std::fs::read_to_string(path).unwrap();
        let (_, diags) = run_examples(&src);
        let e5: Vec<&Diagnostic> = diags.iter().filter(|d| d.code.starts_with("E5")).collect();
        assert!(e5.is_empty(), "{} emitted {e5:?}", path.display());
    }
}

#[test]
fn shipped_examples_are_e5xxx_clean_through_check_program() {
    // The wired pipeline reports no E5xxx on the B1 evidence files.
    let dir = workspace_examples();
    for name in ["TeamTasks.can", "ExpenseFlow.can"] {
        let src = std::fs::read_to_string(dir.join(name)).unwrap();
        let mut db = SourceDb::new();
        let id = db.add(name.to_string(), src);
        let (_program, diags) = canlang_compiler::analysis::check_program(&db, &[id], None);
        let e5: Vec<&Diagnostic> = diags.iter().filter(|d| d.code.starts_with("E5")).collect();
        assert!(e5.is_empty(), "{name} emitted {e5:?}");
    }
}

// --- Check driver ------------------------------------------------------

fn diag(code: &'static str, severity: Severity, file: u32, start: u32) -> Diagnostic {
    Diagnostic {
        code,
        severity,
        message: format!("{code} at {start}"),
        primary: Span::new(SourceId(file), start, start + 1),
        related: Vec::new(),
        tags: Vec::new(),
    }
}

#[test]
fn readiness_gate() {
    let primary = Span::new(SourceId(0), 0, 0);
    assert!(readiness(CompleteInputs::all(primary)).is_empty());
    let all_missing = readiness(CompleteInputs::none(primary));
    assert_eq!(all_missing.len(), 4, "{all_missing:?}");
    assert!(all_missing.iter().all(|d| d.code == "E7006"));
    assert!(all_missing.iter().all(|d| d.primary == primary));
    for (inputs, name) in [
        (
            CompleteInputs {
                resolve: false,
                ..CompleteInputs::all(primary)
            },
            "resolve",
        ),
        (
            CompleteInputs {
                types: false,
                ..CompleteInputs::all(primary)
            },
            "types",
        ),
        (
            CompleteInputs {
                effects: false,
                ..CompleteInputs::all(primary)
            },
            "effects",
        ),
        (
            CompleteInputs {
                examples: false,
                ..CompleteInputs::all(primary)
            },
            "examples",
        ),
    ] {
        let diags = readiness(inputs);
        assert_eq!(diags.len(), 1, "{diags:?}");
        assert_eq!(diags[0].code, "E7006");
        assert!(diags[0].message.contains(name), "{}", diags[0].message);
    }
}

#[test]
fn dedup_keeps_first_across_passes() {
    let mut first = diag("E2001", Severity::Error, 0, 5);
    first.message = "resolve wording".to_string();
    let mut second = diag("E2001", Severity::Error, 0, 5);
    second.message = "types wording".to_string();
    let other_code = diag("E3001", Severity::Error, 0, 5);
    let other_span = diag("E2001", Severity::Error, 0, 6);
    let other_file = diag("E2001", Severity::Error, 1, 5);
    let out = dedup_diagnostics(vec![first, second, other_code, other_span, other_file]);
    assert_eq!(out.len(), 4, "{out:?}");
    assert_eq!(out[0].message, "resolve wording");
}

#[test]
fn sort_matches_check_program_key() {
    let mut diags = vec![
        diag("E3001", Severity::Error, 1, 0),
        diag("E2002", Severity::Error, 0, 9),
        diag("E2001", Severity::Error, 0, 9),
        diag("E2001", Severity::Error, 0, 5),
    ];
    sort_diagnostics(&mut diags);
    let keys: Vec<(u32, u32, &str)> = diags
        .iter()
        .map(|d| (d.primary.file.0, d.primary.start, d.code))
        .collect();
    assert_eq!(
        keys,
        vec![
            (0, 5, "E2001"),
            (0, 9, "E2001"),
            (0, 9, "E2002"),
            (1, 0, "E3001")
        ]
    );
}

#[test]
fn warnings_never_block() {
    assert!(!has_errors(&[]));
    assert_eq!(exit_code(&[]), 0);
    let warning = diag("W1001", Severity::Warning, 0, 0);
    assert!(!has_errors(std::slice::from_ref(&warning)));
    assert_eq!(exit_code(std::slice::from_ref(&warning)), 0);
    let info = diag("I1001", Severity::Info, 0, 1);
    assert_eq!(exit_code(&[warning, info]), 0);
    let error = diag("E5001", Severity::Error, 0, 2);
    assert!(has_errors(std::slice::from_ref(&error)));
    assert_eq!(exit_code(std::slice::from_ref(&error)), 10);
}
