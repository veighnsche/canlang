//! PR5A effects tests: `E4xxx` diagnostics plus the [`EffectTables`]
//! emission input.
//!
//! The pass is included directly until the coordinator wires
//! `analysis::effects`; the root re-exports below let the included module
//! use `crate::` paths that keep working after wiring.

use canlang_compiler::{analysis, diagnostic, source, syntax};

/// Test-only inclusion: the pass's public emission API is read by
/// codegen after wiring, so unread-field lints are allowed here. This
/// does not weaken the library build, where the module will be exported.
#[allow(dead_code)]
#[path = "../src/analysis/effects.rs"]
mod effects;

use analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use analysis::resolve::{self, ResolveTables};
use analysis::types;
use diagnostic::Diagnostic;
use effects::{EffectTables, EffectVerb, check_effects};
use source::{SourceDb, SourceId};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Fresh unique scratch directory under the system temp dir.
fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "can-effects-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Explicitly test-only catalog: builtin shapes transcribed from the
/// DESIGN §3 notation block (never copied from a producer file).
const FIXTURE_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "test-only-0",
  "entries": [
    {"id": "count", "js": "count", "owner": "test", "kind": "builtin", "signature": "count(domain:C<T>)->int", "effects": "pure", "availability": "implemented"},
    {"id": "first", "js": "first", "owner": "test", "kind": "builtin", "signature": "first(domain:ordered C<T>)->T?", "effects": "pure", "availability": "implemented"},
    {"id": "trim", "js": "trim", "owner": "test", "kind": "builtin", "signature": "trim(value:S)->text", "effects": "pure", "availability": "implemented"},
    {"id": "sum", "js": "sum", "owner": "test", "kind": "builtin", "signature": "sum(domain:C<int>)->int; sum(domain:C<decimal>)->decimal; sum(domain:C<duration>)->duration; sum(domain:C<money>,currency:currency)->money; sum(domain:nonempty C<money>)->money", "effects": "pure", "availability": "implemented"},
    {"id": "money", "js": "money", "owner": "test", "kind": "builtin", "signature": "money(value:int,currency:currency)->money; money(value:decimal,currency:currency)->money", "effects": "pure", "availability": "implemented"},
    {"id": "format", "js": "format", "owner": "test", "kind": "builtin", "signature": "format(template:text,values:closed object of Display)->text; format(descriptor:message,locale:locale?)->text", "effects": "pure", "availability": "implemented"},
    {"id": "random_secret", "js": "randomSecret", "owner": "test", "kind": "builtin", "signature": "random_secret()->secret", "effects": "server-default-only", "availability": "implemented"}
  ]
}"#;

/// Load one catalog JSON document through a temp file.
fn load_json_catalog(json: &str) -> (Option<Catalog>, Vec<Diagnostic>) {
    let dir = scratch_dir();
    let path = dir.join("catalog.json");
    std::fs::write(&path, json).unwrap();
    let mut db = SourceDb::new();
    let id = db.add("dummy.can".to_string(), String::new());
    let request = CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: source::Span::new(id, 0, 0),
    };
    load_catalog(&request)
}

/// The test-only fixture catalog (panics unless it loads clean).
fn fixture() -> Catalog {
    let (catalog, diags) = load_json_catalog(FIXTURE_JSON);
    assert!(diags.is_empty(), "fixture must load clean: {diags:?}");
    catalog.expect("fixture catalog")
}

/// Run parse + resolve + types + effects over one source.
fn run(src: &str, catalog: Option<&Catalog>) -> (ResolveTables, EffectTables, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    run_db(&db, &[id], catalog)
}

/// Run the full pipeline over database sources.
fn run_db(
    db: &SourceDb,
    files: &[SourceId],
    catalog: Option<&Catalog>,
) -> (ResolveTables, EffectTables, Vec<Diagnostic>) {
    let mut trees = Vec::with_capacity(files.len());
    let mut diags = Vec::new();
    for &file in files {
        let (tree, mut parse_diags) = syntax::parse(db, file);
        diags.append(&mut parse_diags);
        trees.push((file, tree));
    }
    let tables = resolve::resolve_program(db, &trees, catalog, &mut diags);
    let typed = types::check_types(db, &trees, catalog, &tables, &mut diags);
    resolve::emit_unresolved(db, &tables, &typed, &mut diags);
    let effects = check_effects(db, &trees, &tables, &typed, catalog, &mut diags);
    diags.sort_by(|a, b| {
        (a.primary.file, a.primary.start, &a.code).cmp(&(b.primary.file, b.primary.start, &b.code))
    });
    (tables, effects, diags)
}

/// Sorted diagnostic codes of one run.
fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    let mut out: Vec<&str> = diags.iter().map(|d| d.code).collect();
    out.sort();
    out
}

/// Assert the exact diagnostic codes of one source.
#[track_caller]
fn assert_codes(src: &str, catalog: Option<&Catalog>, expected: &[&str]) {
    let (_, _, diags) = run(src, catalog);
    let mut want: Vec<&str> = expected.to_vec();
    want.sort();
    assert_eq!(
        codes(&diags),
        want,
        "source:\n{src}\nall diagnostics: {diags:?}"
    );
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

// --- B1 evidence files stay E4xxx-clean ------------------------------------

/// Read a workspace example by file name.
fn example(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../examples")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn teamtasks_stays_e4_clean() {
    let src = example("TeamTasks.can");
    let catalog = fixture();
    let (tables, effects, diags) = run(&src, Some(&catalog));
    let e4: Vec<&Diagnostic> = diags.iter().filter(|d| d.code.starts_with("E4")).collect();
    assert!(
        e4.is_empty(),
        "TeamTasks.can must stay E4xxx-clean, got {e4:?}\nall: {diags:?}"
    );
    // Tables still record the evidence: two models, two policies, messages.
    assert_eq!(effects.models.len(), 2, "Todo + Note");
    let policies: usize = effects.models.values().map(|m| m.policies.len()).sum();
    assert_eq!(policies, 2);
    assert_eq!(
        effects.messages.len(),
        4,
        "add + field_title + done + reply"
    );
    // `format(` appears only in an example cell, which the examples pass owns.
    assert_eq!(effects.referenced_builtins, vec!["count"]);
    let pages: usize = effects.modules.values().map(|m| m.pages.len()).sum();
    assert_eq!(pages, 2);
    let _ = tables;
}

#[test]
fn expenseflow_stays_e4_clean() {
    let src = example("ExpenseFlow.can");
    let catalog = fixture();
    let (tables, effects, diags) = run(&src, Some(&catalog));
    let e4: Vec<&Diagnostic> = diags.iter().filter(|d| d.code.starts_with("E4")).collect();
    assert!(
        e4.is_empty(),
        "ExpenseFlow.can must stay E4xxx-clean, got {e4:?}\nall: {diags:?}"
    );
    assert_eq!(
        effects.scenarios.len(),
        4,
        "submit+approve+reject+summarize"
    );
    assert_eq!(
        effects.referenced_builtins,
        vec!["count", "money", "sum", "trim"]
    );
    let expense = tables
        .by_canonical
        .get("expenses.Expense")
        .copied()
        .expect("expenses.Expense symbol");
    let data = effects.models.get(&expense).expect("Expense tables");
    assert_eq!(data.policies.len(), 2);
    assert_eq!(data.locks.len(), 2);
    assert_eq!(data.invariants.len(), 1);
    // `delete=none` leaves only create+update generated ops.
    let ops: Vec<_> = effects
        .crud_ops
        .values()
        .filter(|op| op.model == expense)
        .collect();
    assert_eq!(ops.len(), 2);
    // Submit carries one leading guard and one set effect.
    let submit = tables
        .by_canonical
        .get("expenses.submit")
        .copied()
        .expect("expenses.submit symbol");
    let body = effects.scenarios.get(&submit).expect("submit body");
    assert_eq!(body.guards.len(), 1);
    assert_eq!(body.effects.len(), 1);
    assert_eq!(body.effects[0].verb, EffectVerb::Set);
}

// --- E4001 cross-package mutation ------------------------------------------

const CROSS_MUTATION: &str = r#"# Cross-package mutation fixture.
app Shop
Given
 export Note { title:text }
When
 scenario own(n:Note) by=members
  do set n {title="here"}
Then
package Other
 use Shop {Note}
 Given
 When
  scenario set_foreign(foreign:Note) by=members
   do set foreign {title="there"}
  scenario make_foreign(n:int) by=members
   do create Note {title="made"} as made
  scenario drop_foreign(gone:Note) by=members
   do delete gone
 Then
"#;

#[test]
fn cross_package_mutation() {
    let catalog = fixture();
    let (_, _, diags) = run(CROSS_MUTATION, Some(&catalog));
    assert_findings(
        CROSS_MUTATION,
        &diags,
        &[
            ("E4001", "foreign", 3),
            ("E4001", "Note", 5),
            ("E4001", "gone", 2),
        ],
    );
}

// --- E4002 cross-package rule ----------------------------------------------

const CROSS_RULE: &str = r#"# Cross-package rule fixture.
app Shop
Given
 export Note { title:text }
When
Then
package Other
 use Shop {Note}
 Given
  policy Note read=members
 When
 Then
"#;

#[test]
fn cross_package_rule() {
    let catalog = fixture();
    let (_, _, diags) = run(CROSS_RULE, Some(&catalog));
    assert_findings(CROSS_RULE, &diags, &[("E4002", "Note", 3)]);
}

// --- E4003 cross-package crud ----------------------------------------------

const CROSS_CRUD: &str = r#"# Cross-package crud fixture.
app Shop
Given
 export Note { title:text }
When
Then
package Other
 use Shop {Note}
 Given
 When
  crud Note by=members fields=title
 Then
"#;

#[test]
fn cross_package_crud() {
    let catalog = fixture();
    let (_, _, diags) = run(CROSS_CRUD, Some(&catalog));
    assert_findings(CROSS_CRUD, &diags, &[("E4003", "Note", 3)]);
}

// --- E4004 app scope needs policy ------------------------------------------

const APP_NO_POLICY: &str = r#"# App scope without a policy.
app Shop
Given
 Config in app { name:text }
When
Then
"#;

const APP_WITH_POLICY: &str = r#"# App scope with a policy.
app Shop
Given
 Config in app { name:text }
 policy Config read=members
When
Then
"#;

#[test]
fn app_scope_needs_policy() {
    let catalog = fixture();
    let (_, _, diags) = run(APP_NO_POLICY, Some(&catalog));
    assert_findings(APP_NO_POLICY, &diags, &[("E4004", "Config", 1)]);
    assert_codes(APP_WITH_POLICY, Some(&catalog), &[]);
}

// --- E4010 secret field grant ----------------------------------------------

const SECRET_GRANT: &str = r#"# Secret field grant fixture.
app Shop
Given
 Token { value:secret server=random_secret() }
 policy Token read=members fields=value
When
Then
"#;

const SECRET_UNGRANTD: &str = r#"# Omitted fields grant no secrets.
app Shop
Given
 Token { value:secret server=random_secret() }
 policy Token read=members
When
Then
"#;

#[test]
fn secret_field_grant() {
    let catalog = fixture();
    let (_, _, diags) = run(SECRET_GRANT, Some(&catalog));
    assert_findings(SECRET_GRANT, &diags, &[("E4010", "value", 2)]);
    assert_codes(SECRET_UNGRANTD, Some(&catalog), &[]);
}

// --- E4011 secret return ---------------------------------------------------

const SECRET_RETURN: &str = r#"# Secret return fixture.
app Shop
Given
When
 scenario leak(sek:secret) -> secret by=members
  do return sek
 scenario ok(n:int) -> int by=members
  do return n
Then
"#;

#[test]
fn secret_return() {
    let catalog = fixture();
    let (_, _, diags) = run(SECRET_RETURN, Some(&catalog));
    assert_findings(SECRET_RETURN, &diags, &[("E4011", "sek", 2)]);
}

// --- E4020 redundant actor subject -----------------------------------------

const REDUNDANT_ACTOR: &str = r#"# Redundant subject fixture.
app Shop
Given
 role reviewer
When
 scenario flagged(n:int) -> int by=members
  require reviewer(actor)
  do return n
 scenario clean(who:user, n:int) -> int by=members
  require reviewer(who)
  do return n
Then
"#;

#[test]
fn redundant_actor_subject() {
    let catalog = fixture();
    let (_, _, diags) = run(REDUNDANT_ACTOR, Some(&catalog));
    assert_findings(REDUNDANT_ACTOR, &diags, &[("E4020", "actor", 1)]);
}

// --- E4030 unreachable after return ----------------------------------------

const UNREACHABLE: &str = r#"# Unreachable statement fixture.
app Shop
Given
When
 scenario early(n:int) -> int by=members
  do
   return n
   let leftover=1
 scenario branched(n:int) -> int by=members
  do
   if n==1
    return 1
    return 2
   return 3
Then
"#;

#[test]
fn unreachable_after_return() {
    let catalog = fixture();
    let (_, _, diags) = run(UNREACHABLE, Some(&catalog));
    assert_findings(
        UNREACHABLE,
        &diags,
        &[("E4030", "let leftover=1", 1), ("E4030", "return 2", 1)],
    );
}

// --- E4040 call remote target ----------------------------------------------

const CALL_REMOTE: &str = r#"# Bound call target fixture.
package Shop
 Given
 When
  export scenario work(n:int) -> int by=members
   do return n
 Then
package Other
 use Shop {work} from=deployment.shop
 Given
 When
  scenario remote(n:int) -> int by=members
   do
    call work {n=n} as r
    return r
 Then
package Third
 use Shop {work}
 Given
 When
  scenario local(n:int) -> int by=members
   do
    call work {n=n} as r
    return r
 Then
"#;

#[test]
fn call_remote_target() {
    let catalog = fixture();
    let (_, _, diags) = run(CALL_REMOTE, Some(&catalog));
    assert_findings(CALL_REMOTE, &diags, &[("E4040", "work", 3)]);
}

// --- E4041 heterogeneous action call ---------------------------------------

const HETEROGENEOUS_ACTION: &str = r#"# Heterogeneous action call fixture.
app Shop
Given
When
 scenario set_text(v:text) by=members
  do
   let x=v
 scenario set_num(v:int) by=members
  do
   let y=v
 scenario pick(ref:action(set_text,set_num)) by=members
  do
   call ref {v="s"}
   let done=1
Then
"#;

#[test]
fn heterogeneous_action_call() {
    let catalog = fixture();
    let (_, _, diags) = run(HETEROGENEOUS_ACTION, Some(&catalog));
    assert_findings(HETEROGENEOUS_ACTION, &diags, &[("E4041", "\"s\"", 1)]);
}

// --- E4042 delete disabled -------------------------------------------------

const DELETE_DISABLED: &str = r#"# Delete disabled fixture.
app Shop
Given
 Todo { title:text }
When
 crud Todo by=members fields=title delete=none
 scenario wipe(gone:Todo) by=members
  do delete gone
Then
"#;

#[test]
fn delete_disabled() {
    let catalog = fixture();
    let (_, _, diags) = run(DELETE_DISABLED, Some(&catalog));
    assert_findings(DELETE_DISABLED, &diags, &[("E4042", "gone", 2)]);
}

// --- E4050 hook on disabled op ---------------------------------------------

const HOOK_DISABLED: &str = r#"# Hook on a disabled operation.
app Shop
Given
 Todo { title:text }
When
 crud Todo by=members fields=title delete=none
 scenario no_remove on=Todo.delete
  do
   let x=1
Then
"#;

#[test]
fn hook_on_disabled_op() {
    let catalog = fixture();
    let (_, _, diags) = run(HOOK_DISABLED, Some(&catalog));
    assert_findings(HOOK_DISABLED, &diags, &[("E4050", "Todo.delete", 1)]);
}

// --- E4051 mixed handler scope ---------------------------------------------

const MIXED_SCOPE: &str = r#"# Mixed handler scope fixture.
app Shop
Given
 AppConfig in app { name:text }
 Todo { title:text }
 policy AppConfig read=members
When
 scenario tick on=every(5m)
  do
   let n=count(Todo)
   create AppConfig {name="x"} as c
 scenario team_only on=every(5m)
  do
   let m=count(Todo)
Then
"#;

#[test]
fn mixed_handler_scope() {
    let catalog = fixture();
    let (_, _, diags) = run(MIXED_SCOPE, Some(&catalog));
    assert_findings(MIXED_SCOPE, &diags, &[("E4051", "every(5m)", 1)]);
}

// --- Emission table shapes -------------------------------------------------

const SHAPES: &str = r#"# Table shape fixture.
app Shop
Given
 Todo { title:text trim max=200, done:bool=false } label="Task"@{nl="Taak"}
 policy Todo read=members fields=title,done
 invariant Todo: trim(row.title)!=""
 unique Todo fields=title
 lock Todo fields=title when=row.done
 retain Todo until=row.created+30d
 message add = "Add"@{nl="Toevoegen"}
 role reviewer label="Reviewer"@{nl="Beoordelaar"}
 derive Todo.slug:text = trim(row.title)
 capability Mail version=1
  send(to:text) -> text
When
 crud Todo by=members fields=title,done label={create=add}
 scenario close(t:Todo, note:text = "done") by=members
  require t.done==false
  do set t {done=true}
Then
 page / title="Shop"@{nl="Winkel"}
"#;

#[test]
fn emission_table_shapes() {
    let catalog = fixture();
    let (tables, effects, diags) = run(SHAPES, Some(&catalog));
    assert_eq!(
        codes(&diags),
        Vec::<&str>::new(),
        "shapes fixture must check clean: {diags:?}"
    );
    let module = tables.module_by_name["Shop"];
    let todo = tables.by_canonical["Shop.Todo"];
    let data = effects.models.get(&todo).expect("Todo tables");
    assert_eq!(data.fields.len(), 2);
    assert_eq!(data.fields[0].modifiers.len(), 2, "trim + max");
    assert!(data.fields[1].default.is_some(), "done=false");
    assert!(data.label.is_some());
    assert_eq!(data.policies.len(), 1);
    assert_eq!(data.policies[0].fields, vec!["title", "done"]);
    assert!(data.policies[0].read.is_some());
    assert_eq!(data.invariants.len(), 1);
    assert!(data.invariants[0].predicate.is_some());
    assert_eq!(data.uniques.len(), 1);
    assert_eq!(data.locks.len(), 1);
    assert!(data.locks[0].when.is_some());
    assert_eq!(data.retains.len(), 1);
    assert!(data.retains[0].until.is_some());
    // Rule ids are unique ordinals.
    let ids = [
        data.policies[0].id,
        data.invariants[0].id,
        data.uniques[0].id,
        data.locks[0].id,
        data.retains[0].id,
    ];
    let mut sorted = ids.to_vec();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), 5);
    // Module-level rule refs mirror the per-model vectors.
    let module_data = effects.modules.get(&module).expect("Shop module");
    assert_eq!(module_data.policies.len(), 1);
    assert_eq!(module_data.invariants.len(), 1);
    assert_eq!(module_data.uniques.len(), 1);
    assert_eq!(module_data.locks.len(), 1);
    assert_eq!(module_data.retains.len(), 1);
    assert_eq!(module_data.policies[0].model, todo);
    assert_eq!(module_data.pages.len(), 1);
    assert!(module_data.pages[0].title.is_some());
    assert!(!module_data.descriptions.is_empty(), "app description");
    // Scenario body: one guard, one set effect, param default.
    let close = tables.by_canonical["Shop.close"];
    let body = effects.scenarios.get(&close).expect("close body");
    assert_eq!(body.guards.len(), 1);
    assert_eq!(body.effects.len(), 1);
    assert_eq!(body.effects[0].verb, EffectVerb::Set);
    assert_eq!(body.effects[0].args.len(), 1);
    assert_eq!(body.effects[0].args[0].key, "done");
    assert_eq!(body.params.len(), 2);
    assert!(body.params[1].default.is_some(), "note default");
    // Message text and variants.
    let add = tables.by_canonical["Shop.add"];
    let message = effects.messages.get(&add).expect("add message");
    assert_eq!(message.source, "Add");
    assert_eq!(message.variants.len(), 1);
    assert_eq!(message.variants[0].locale, "nl");
    assert_eq!(message.variants[0].value.as_deref(), Some("Toevoegen"));
    // Capability version and catalog echo.
    let mail = tables.by_canonical["Shop.Mail"];
    let capability = effects.capabilities.get(&mail).expect("Mail tables");
    assert_eq!(capability.version, Some(1));
    assert_eq!(capability.catalog_version, "test-only-0");
    assert_eq!(capability.ops.len(), 1);
    assert_eq!(capability.ops[0].params.len(), 1);
    // Derive expression.
    assert_eq!(effects.derives.len(), 1);
    let derive = effects.derives.values().next().unwrap();
    assert!(derive.expr.is_some());
    assert_eq!(derive.model, Some(todo));
    // Role label.
    let reviewer = tables.by_canonical["Shop.reviewer"];
    assert!(effects.roles.get(&reviewer).and_then(|r| r.label).is_some());
    // Builtins referenced from checked positions (rule + derive).
    assert_eq!(effects.referenced_builtins, vec!["trim"]);
}

const MIGRATION: &str = r#"# Migration fixture.
app Shop
Given
 Todo { title:text }
When
Then
migration Shop from="snap-1"
 rename before.Todo to Task
 invalidate before.cleanup
"#;

#[test]
fn migration_tables() {
    let catalog = fixture();
    let (tables, effects, diags) = run(MIGRATION, Some(&catalog));
    assert_eq!(
        codes(&diags),
        Vec::<&str>::new(),
        "migration fixture must check clean: {diags:?}"
    );
    assert_eq!(effects.migrations.len(), 1);
    let migration = &effects.migrations[0];
    assert_eq!(migration.owner, "Shop");
    assert_eq!(migration.module, tables.module_by_name.get("Shop").copied());
    assert_eq!(migration.from.as_deref(), Some("snap-1"));
    assert_eq!(migration.directives.len(), 2);
    match &migration.directives[0] {
        effects::MigrationDirective::Rename { from, to, .. } => {
            assert_eq!(from, "before.Todo");
            assert_eq!(to.as_deref(), Some("Task"));
        }
        other => panic!("expected rename, got {other:?}"),
    }
    match &migration.directives[1] {
        effects::MigrationDirective::Invalidate { handler, .. } => {
            assert_eq!(handler, "before.cleanup");
        }
        other => panic!("expected invalidate, got {other:?}"),
    }
    let module = tables.module_by_name["Shop"];
    assert_eq!(effects.modules[&module].migrations, vec![0]);
}

// --- Transitive scope, hooks, backfills, bound CRUD --------------------------

const TRANSITIVE_SCOPE: &str = r#"# Transitive handler scope fixture.
app Shop
Given
 AppConfig in app { name:text }
 Todo { title:text }
 policy AppConfig read=members
When
 scenario helper(n:int) by=members
  do
   create AppConfig {name="x"} as c
   let done=n
 scenario tick on=every(5m)
  do
   let m=count(Todo)
   call helper {n=1}
Then
"#;

#[test]
fn transitive_handler_scope() {
    let catalog = fixture();
    let (_, _, diags) = run(TRANSITIVE_SCOPE, Some(&catalog));
    assert_findings(TRANSITIVE_SCOPE, &diags, &[("E4051", "every(5m)", 1)]);
}

const HOOK_ADJUST: &str = r#"# Hook pending-record fixture.
app Shop
Given
 Todo { title:text }
When
 scenario fix on=Todo.create
  do
   set event.after {title="t"}
Then
"#;

#[test]
fn hook_tables() {
    use effects::{EffectTarget, HandlerSource};
    let catalog = fixture();
    let (tables, effects, diags) = run(HOOK_ADJUST, Some(&catalog));
    assert_eq!(
        codes(&diags),
        Vec::<&str>::new(),
        "hook adjust must check clean: {diags:?}"
    );
    let fix = tables.by_canonical["Shop.fix"];
    let body = effects.scenarios.get(&fix).expect("fix body");
    let todo = tables.by_canonical["Shop.Todo"];
    assert!(matches!(
        body.on,
        Some(HandlerSource::Hook { model, .. }) if model == todo
    ));
    assert_eq!(body.effects.len(), 1);
    assert_eq!(body.effects[0].verb, EffectVerb::Set);
    assert!(matches!(
        body.effects[0].target,
        Some(EffectTarget::PendingRecord { model }) if model == todo
    ));
}

const BACKFILL_SUITE: &str = r#"# Backfill suite fixture.
app Shop
Given
 Todo { title:text }
When
Then
migration Shop from="s"
 backfill Todo
  require true
  do
   let x=1
"#;

#[test]
fn backfill_tables() {
    let catalog = fixture();
    let (tables, effects, diags) = run(BACKFILL_SUITE, Some(&catalog));
    assert_eq!(
        codes(&diags),
        Vec::<&str>::new(),
        "backfill fixture must check clean: {diags:?}"
    );
    assert_eq!(effects.migrations.len(), 1);
    match &effects.migrations[0].directives[..] {
        [
            effects::MigrationDirective::Backfill {
                model,
                resolved,
                guards,
                effects: fx,
                ..
            },
        ] => {
            assert_eq!(model, "Todo");
            assert_eq!(*resolved, tables.by_canonical.get("Shop.Todo").copied());
            assert_eq!(guards.len(), 1);
            assert_eq!(fx.len(), 1);
        }
        other => panic!("expected one backfill, got {other:?}"),
    }
}

const BOUND_CRUD_CALL: &str = r#"# Bound CRUD call stays local-path.
package Shop
 Given
  export Note { title:text }
 When
  crud Note by=members fields=title
 Then
package Other
 use Shop {Note} from=deployment.shop
 Given
 When
  scenario t(n:int) by=members
   do
    call Note.create {title="x"} as r
    let done=n
 Then
"#;

#[test]
fn bound_crud_call_exempt() {
    // Generated CRUD operations are exempt from E4040: `send` does not
    // accept them, so flagging the call would leave no valid path.
    let catalog = fixture();
    assert_codes(BOUND_CRUD_CALL, Some(&catalog), &[]);
}
