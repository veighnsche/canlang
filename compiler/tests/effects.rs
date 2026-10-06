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

// --- E4001 member-path mutation (PR5 review B2) ------------------------------

const CROSS_MUTATION_MEMBER: &str = r#"# Cross-package member-path mutation fixture.
app Shop
Given
 export Customer { name:text }
 export Order { customer:Customer }
When
Then
package Other
 use Shop {Order, Customer}
 Given
 When
  scenario touch_member(o:Order) by=members
   do set o.customer {name="there"}
  scenario drop_member(o:Order) by=members
   do delete o.customer
 Then
"#;

const SAME_PACKAGE_MEMBER: &str = r#"# Same-package member paths stay clean.
app Shop
Given
 Customer { name:text }
 Order { customer:Customer }
When
 scenario touch_member(o:Order) by=members
  do set o.customer {name="here"}
 scenario drop_member(o:Order) by=members
  do delete o.customer
Then
"#;

#[test]
fn cross_package_member_mutation() {
    let catalog = fixture();
    let (_, _, diags) = run(CROSS_MUTATION_MEMBER, Some(&catalog));
    assert_findings(
        CROSS_MUTATION_MEMBER,
        &diags,
        &[("E4001", "o.customer", 1), ("E4001", "o.customer", 2)],
    );
    assert_codes(SAME_PACKAGE_MEMBER, Some(&catalog), &[]);
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

// --- E4010 nullable secrets (PR5 review B3) ----------------------------------

const SECRET_GRANT_NULLABLE: &str = r#"# Nullable secret grant fixture.
app Shop
Given
 Token { value:secret? server=random_secret() }
 policy Token read=members fields=value
When
Then
"#;

const SECRET_GRANT_NESTED_NULLABLE: &str = r#"# Nullable-intermediate secret grant fixture.
app Shop
Given
 contract Profile { token:secret server=random_secret() }
 Token { profile:Profile? }
 policy Token read=members fields=profile.token
When
Then
"#;

const NULLABLE_NON_SECRET: &str = r#"# Nullable non-secret grants stay clean.
app Shop
Given
 Token { nick:text? }
 policy Token read=members fields=nick
When
Then
"#;

#[test]
fn nullable_secret_grant() {
    let catalog = fixture();
    let (_, _, diags) = run(SECRET_GRANT_NULLABLE, Some(&catalog));
    assert_findings(SECRET_GRANT_NULLABLE, &diags, &[("E4010", "value", 2)]);
    let (_, _, diags) = run(SECRET_GRANT_NESTED_NULLABLE, Some(&catalog));
    assert_findings(
        SECRET_GRANT_NESTED_NULLABLE,
        &diags,
        &[("E4010", "profile.token", 1)],
    );
    assert_codes(NULLABLE_NON_SECRET, Some(&catalog), &[]);
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

// --- E4051 write-only evidence (PR5 review B4) --------------------------------

const WRITE_ONLY_SCOPE: &str = r#"# Write-only transitive scope fixture.
app Shop
Given
 AppConfig in app { name:text }
 TeamModel { title:text }
 policy AppConfig read=members
When
 scenario passthru(m:TeamModel) -> TeamModel by=members
  do return m
 scenario tick on=every(5m)
  do
   call passthru {} as x
   set x {title="t"}
   create AppConfig {name="x"} as c
Then
"#;

#[test]
fn write_only_handler_scope() {
    // B4: the helper's model set is empty (no query/create in its
    // body), so the team model enters only through the `set` on the
    // call result. E4051 must still fire. (The call omits its required
    // input on purpose: E3009 pins the opaque entry.)
    let catalog = fixture();
    let (_, _, diags) = run(WRITE_ONLY_SCOPE, Some(&catalog));
    assert_findings(
        WRITE_ONLY_SCOPE,
        &diags,
        &[("E3009", "{}", 1), ("E4051", "every(5m)", 1)],
    );
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

// --- PR5 review: containment cycle terminates (B1) --------------------------

const CONTAINMENT_CYCLE: &str = r#"# Containment cycle with a handler touch.
app Shop
Given
 A in B { x:text }
 B in A { y:text }
When
 scenario tick on=every(5m)
  do
   let n=count(A)
Then
"#;

#[test]
fn containment_cycle_terminates() {
    // B1: resolve reports the cycle (E2008); the effects scope walk
    // must terminate instead of looping on the ChildOf links. (Two
    // nodes only: a regression hangs this test loudly by timeout.)
    let catalog = fixture();
    let (_, _, diags) = run(CONTAINMENT_CYCLE, Some(&catalog));
    assert_findings(
        CONTAINMENT_CYCLE,
        &diags,
        &[("E2008", "A", 1), ("E2008", "B", 2)],
    );
}

// --- T25-L1 leaf grants ------------------------------------------------------

const LEAF_GRANT_MAIL: &str = r#"# Mail-shaped leaf grants stay clean.
package p
 use p {Mail as Box} from=deployment.mail
 Given
  export capability Mail version=1
   send(to:text) -> Ack
  contract Ack { ok:bool }
  Item { title:text, notification:delivery(Box.send)? }
  derive Item.notice_state:text = row.title
  policy Item read=members fields=title,notice_state,notification.status
 When
 Then
"#;

const LEAF_GRANT_SCHEMA: &str = r#"# Declared observation leaves are well-formed grants.
package p
 use p {Mail as Box} from=deployment.mail
 Given
  export capability Mail version=1
   send(to:text) -> Ack
  contract Ack { ok:bool }
  Item { title:text, notification:delivery(Box.send)? }
  derive Item.notice_state:text = row.title
  policy Item read=members fields=notice_state
  policy Item read=members fields=notification.id,notification.result,notification.error
  policy Item read=members fields=notification
 When
 Then
"#;

#[test]
fn t25_l1_valid_leaf_grants_stay_clean() {
    // The checker accepts every well-formed spelling independently: the
    // derived field alone, the derived field plus its status-leaf
    // dependency, each declared observation leaf, and the whole-field
    // grant. Which leaves are readable under a grant (withholding,
    // parent-subsumes, no-implicit-expansion) is runtime (T25-L3).
    let catalog = fixture();
    assert_codes(LEAF_GRANT_MAIL, Some(&catalog), &[]);
    assert_codes(LEAF_GRANT_SCHEMA, Some(&catalog), &[]);
}

const LEAF_GRANT_VALUES: &str = r#"# Embedded value leaves stay clean.
app Shop
Given
 contract Profile { name:text }
 Item { title:text, profile:Profile?, amount:money }
 policy Item read=members fields=profile.name,amount.minor,amount.currency
When
Then
"#;

#[test]
fn t25_l1_embedded_value_leaves_stay_clean() {
    // Contract descent and money value leaves are typed value
    // components, not references: no E4012.
    let catalog = fixture();
    assert_codes(LEAF_GRANT_VALUES, Some(&catalog), &[]);
}

const LEAF_GRANT_BOGUS: &str = r#"# Unknown delivery leaf rejected.
package p
 use p {Mail as Box} from=deployment.mail
 Given
  export capability Mail version=1
   send(to:text) -> Ack
  contract Ack { ok:bool }
  Item { title:text, notification:delivery(Box.send)? }
  policy Item read=members fields=notification.bogus
 When
 Then
"#;

const LEAF_GRANT_CROSS_RECORD: &str = r#"# Cross-record traversal rejected.
app Shop
Given
 Service { title:text }
 Item { title:text, service:Service? }
 policy Item read=members fields=service.title
When
Then
"#;

#[test]
fn t25_l1_unsupported_traversal_stays_e2013() {
    // Unknown observation leaves and traversal through a model
    // reference to another record's fields fail in the types pass
    // (E2013); L1 adds no second diagnostic.
    let catalog = fixture();
    let (_, _, diags) = run(LEAF_GRANT_BOGUS, Some(&catalog));
    assert_findings(
        LEAF_GRANT_BOGUS,
        &diags,
        &[("E2013", "notification.bogus", 1)],
    );
    let (_, _, diags) = run(LEAF_GRANT_CROSS_RECORD, Some(&catalog));
    assert_findings(
        LEAF_GRANT_CROSS_RECORD,
        &diags,
        &[("E2013", "service.title", 1)],
    );
}

const LEAF_GRANT_USER: &str = r#"# User-reference traversal rejected.
app Shop
Given
 Item { title:text, owner:user }
 policy Item read=members fields=title,owner.id
When
Then
"#;

#[test]
fn t25_l1_user_traversal_is_e4012() {
    let catalog = fixture();
    let (_, _, diags) = run(LEAF_GRANT_USER, Some(&catalog));
    assert_findings(LEAF_GRANT_USER, &diags, &[("E4012", "owner.id", 1)]);
}

const LEAF_GRANT_MEMBER: &str = r#"# Member-reference traversal rejected.
app Shop
Given
 Todo { title:text, assignee:member? }
 policy Todo read=members fields=assignee.user.id
 policy Todo read=members fields=created_by.id
When
Then
"#;

#[test]
fn t25_l1_member_traversal_is_e4012() {
    // Member chains (through nullable too) and reserved user-metadata
    // heads traverse references: E4012 on each path.
    let catalog = fixture();
    let (_, _, diags) = run(LEAF_GRANT_MEMBER, Some(&catalog));
    assert_findings(
        LEAF_GRANT_MEMBER,
        &diags,
        &[
            ("E4012", "assignee.user.id", 1),
            ("E4012", "created_by.id", 1),
        ],
    );
}

const LEAF_GRANT_UNKNOWN_SOLO: &str = r#"# Unknown leaves stay E2013-only.
app Shop
Given
 contract Profile { name:text }
 Item { title:text, profile:Profile?, owner:user }
 policy Item read=members fields=profile.bogus,owner.bogus
When
Then
"#;

#[test]
fn t25_l1_unknown_leaves_stay_e2013_only() {
    // Unknown segments fail in the types pass even on reference bases
    // (`owner.bogus` is not `owner.id`); L1 stays silent, so each bad
    // path reports exactly one diagnostic.
    let catalog = fixture();
    let (_, _, diags) = run(LEAF_GRANT_UNKNOWN_SOLO, Some(&catalog));
    assert_findings(
        LEAF_GRANT_UNKNOWN_SOLO,
        &diags,
        &[("E2013", "profile.bogus", 1), ("E2013", "owner.bogus", 1)],
    );
}

// --- T34-F6 each= cohort check (E4055) --------------------------------------
//
// F6 proves M9/M10 on the compiler side: both adopted cohort spellings
// check (bare model + parent-anchored collection) with the real
// Shift/Volunteer bodies accepted without trimming, while unknown,
// cross-owner and unsupported cohort forms fail with precise E4055
// diagnostics and ordinary bounded loops keep their existing rules.
//
// Standing context (not F6's): the parser still marks every each= with
// E1203 (narrowing it to out-of-contract forms belongs to the parser
// owner), and binding the `as` name in body scope belongs to the
// resolve join, so bodies referencing the child binding carry
// pre-existing E2001/E2013/E3001 cascades. F6's contract: zero E4055
// on valid forms (no NEW findings on valid bodies), exact E4055 on
// invalid forms, and cohort descriptors only for checked cohorts.

/// E4055 findings as sorted (message, start, end).
fn e4055(diags: &[Diagnostic]) -> Vec<(&str, u32, u32)> {
    let mut out: Vec<(&str, u32, u32)> = diags
        .iter()
        .filter(|d| d.code == "E4055")
        .map(|d| (d.message.as_str(), d.primary.start, d.primary.end))
        .collect();
    out.sort();
    out
}

/// Read a workspace draft by file name (read-only: this suite never
/// writes the draft submodule).
fn draft(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../draft")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

const F6_BARE: &str = r#"# Bare-model cohort fixture.
app Shop
Given
 Todo { title:text }
 event Ping {}
When
 scenario sweep on=Ping each=Todo as todo
  do
   let x=1
Then
"#;

#[test]
fn f6_bare_model_checks_with_only_the_standing_e1203() {
    use effects::CohortKind;
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_BARE, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E1203"], "all diagnostics: {diags:?}");
    let sweep = tables.by_canonical["Shop.sweep"];
    let body = effects.scenarios.get(&sweep).expect("sweep body");
    let cohort = body.cohort.as_ref().expect("checked cohort");
    assert_eq!(cohort.kind, CohortKind::Model);
    assert_eq!(cohort.model, tables.by_canonical["Shop.Todo"]);
    assert_eq!(cohort.bind.as_deref(), Some("todo"));
    assert!(cohort.parent_path.is_empty());
}

const F6_ANCHORED: &str = r#"# Parent-anchored cohort fixture.
app Shop
Given
 Community { name:text }
 Opportunity in Community { title:text }
 Signup in Opportunity { email:text }
 event Cancelled { opportunity:Opportunity, reason:text }
When
 scenario cancel_each on=Cancelled each=event.opportunity.Signup as signup
  do
   let x=1
Then
"#;

#[test]
fn f6_anchored_collection_checks_with_only_the_standing_e1203() {
    use effects::CohortKind;
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_ANCHORED, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E1203"], "all diagnostics: {diags:?}");
    let cancel = tables.by_canonical["Shop.cancel_each"];
    let body = effects.scenarios.get(&cancel).expect("cancel_each body");
    let cohort = body.cohort.as_ref().expect("checked cohort");
    assert_eq!(cohort.kind, CohortKind::AnchoredCollection);
    assert_eq!(cohort.model, tables.by_canonical["Shop.Signup"]);
    assert_eq!(cohort.bind.as_deref(), Some("signup"));
    assert_eq!(cohort.parent_path, vec!["event", "opportunity"]);
}

const F6_COMMITTED_BARE: &str = r#"# Committed-trigger bare-model cohort (refresh_reminders shape).
app Shop
Given
 Community { name:text }
 Opportunity in Community { title:text }
 Signup in Opportunity { email:text }
When
 scenario refresh on=Opportunity.updated each=Signup as signup
  do
   let x=1
Then
"#;

#[test]
fn f6_committed_trigger_bare_model_checks() {
    use effects::CohortKind;
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_COMMITTED_BARE, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E1203"], "all diagnostics: {diags:?}");
    let refresh = tables.by_canonical["Shop.refresh"];
    let body = effects.scenarios.get(&refresh).expect("refresh body");
    let cohort = body.cohort.as_ref().expect("checked cohort");
    assert_eq!(cohort.kind, CohortKind::Model);
    assert_eq!(cohort.model, tables.by_canonical["Shop.Signup"]);
    assert_eq!(cohort.bind.as_deref(), Some("signup"));
}

const F6_NO_BIND: &str = r#"# each= without `as` stays accepted (bind: null downstream).
app Shop
Given
 Todo { title:text }
 event Ping {}
When
 scenario sweep on=Ping each=Todo
  do
   let x=1
Then
"#;

#[test]
fn f6_missing_as_binding_accepted() {
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_NO_BIND, Some(&catalog));
    assert_eq!(codes(&diags), vec!["E1203"], "all diagnostics: {diags:?}");
    let sweep = tables.by_canonical["Shop.sweep"];
    let body = effects.scenarios.get(&sweep).expect("sweep body");
    let cohort = body.cohort.as_ref().expect("checked cohort");
    assert_eq!(cohort.bind, None);
}

const F6_UNKNOWN_MODEL: &str = r#"# Unknown cohort model.
app Shop
Given
 Todo { title:text }
 event Ping {}
When
 scenario sweep on=Ping each=Nosuch as todo
  do
   let x=1
Then
"#;

#[test]
fn f6_unknown_model_diagnosed() {
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_UNKNOWN_MODEL, Some(&catalog));
    let (start, end) = span_of(F6_UNKNOWN_MODEL, "Nosuch", 1);
    assert_eq!(
        e4055(&diags),
        vec![("unknown model `Nosuch` in each= cohort", start, end)],
        "all diagnostics: {diags:?}"
    );
    let sweep = tables.by_canonical["Shop.sweep"];
    let body = effects.scenarios.get(&sweep).expect("sweep body");
    assert!(body.cohort.is_none(), "invalid cohorts emit no descriptor");
}

const F6_UNKNOWN_HOP: &str = r#"# Unknown parent hop in an anchored cohort.
app Shop
Given
 Community { name:text }
 Opportunity in Community { title:text }
 Signup in Opportunity { email:text }
 event Cancelled { opportunity:Opportunity, reason:text }
When
 scenario cancel_each on=Cancelled each=event.bogus.Signup as signup
  do
   let x=1
Then
"#;

#[test]
fn f6_unknown_collection_hop_diagnosed() {
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_UNKNOWN_HOP, Some(&catalog));
    let (start, end) = span_of(F6_UNKNOWN_HOP, "event.bogus.Signup", 1);
    assert_eq!(
        e4055(&diags),
        vec![(
            "unknown collection `bogus` on 'Cancelled' in each= cohort",
            start,
            end
        )],
        "all diagnostics: {diags:?}"
    );
    let cancel = tables.by_canonical["Shop.cancel_each"];
    let body = effects.scenarios.get(&cancel).expect("cancel_each body");
    assert!(body.cohort.is_none(), "invalid cohorts emit no descriptor");
}

const F6_UNCONTAINED: &str = r#"# Anchored child not contained in the resolved parent.
app Shop
Given
 Community { name:text }
 Opportunity in Community { title:text }
 event Cancelled { opportunity:Opportunity, reason:text }
When
 scenario cancel_each on=Cancelled each=event.opportunity.Community as community
  do
   let x=1
Then
"#;

#[test]
fn f6_uncontained_child_diagnosed() {
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_UNCONTAINED, Some(&catalog));
    let (start, end) = span_of(F6_UNCONTAINED, "event.opportunity.Community", 1);
    assert_eq!(
        e4055(&diags),
        vec![(
            "unknown collection `Community` on 'Opportunity': anchored each= cohorts enumerate a contained child collection",
            start,
            end
        )],
        "all diagnostics: {diags:?}"
    );
    let cancel = tables.by_canonical["Shop.cancel_each"];
    let body = effects.scenarios.get(&cancel).expect("cancel_each body");
    assert!(body.cohort.is_none(), "invalid cohorts emit no descriptor");
}

const F6_CROSS_OWNER: &str = r#"# Cross-package (cross-owner) cohort fixture.
app Shop
Given
 export Todo { title:text }
When
Then
package Other
 use Shop {Todo}
 Given
  event Ping {}
 When
  scenario sweep on=Ping each=Todo as todo
   do
    let x=1
 Then
"#;

#[test]
fn f6_cross_owner_cohort_diagnosed() {
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_CROSS_OWNER, Some(&catalog));
    let (start, end) = span_of(F6_CROSS_OWNER, "each=Todo", 1);
    // The finding spans the cohort path (`Todo` after `each=`).
    let (path_start, path_end) = (start + 5, end);
    assert_eq!(
        e4055(&diags),
        vec![(
            "cross-owner each= cohort 'Shop.Todo': cohorts enumerate same-package models (cross-package mutation uses call)",
            path_start,
            path_end
        )],
        "all diagnostics: {diags:?}"
    );
    let sweep = tables.by_canonical["Other.sweep"];
    let body = effects.scenarios.get(&sweep).expect("sweep body");
    assert!(body.cohort.is_none(), "invalid cohorts emit no descriptor");
}

const F6_UNSUPPORTED: &str = r#"# Unsupported cohort forms, one scenario each.
app Shop
Given
 Todo { title:text }
 event Ping {}
When
 scenario rooted_elsewhere on=Ping each=Todo.title as t
  do
   let x=1
 scenario bare_event on=Ping each=event as e
  do
   let x=1
 scenario no_trigger(n:Todo) by=members each=Todo as t
  do
   let x=1
 scenario not_a_model on=Ping each=Ping as p
  do
   let x=1
Then
"#;

#[test]
fn f6_unsupported_forms_diagnosed() {
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_UNSUPPORTED, Some(&catalog));
    let mut messages: Vec<&str> = e4055(&diags).iter().map(|(m, _, _)| *m).collect();
    messages.sort();
    assert_eq!(
        messages,
        vec![
            "each= needs an on= trigger: fanout cohorts freeze under a source-occurrence/handler cutoff",
            "each=event is not a cohort: use a bare model (each=Signup) or an event-anchored collection (each=event.opportunity.Signup)",
            "unsupported each= cohort `Todo.title`: multi-segment cohorts root at event (each=event.opportunity.Signup)",
            "unsupported each= cohort `Ping`: cohorts enumerate models",
        ],
        "all diagnostics: {diags:?}"
    );
    for name in [
        "Shop.rooted_elsewhere",
        "Shop.bare_event",
        "Shop.no_trigger",
        "Shop.not_a_model",
    ] {
        let body = effects
            .scenarios
            .get(&tables.by_canonical[name])
            .expect(name);
        assert!(body.cohort.is_none(), "{name} emits no descriptor");
    }
}

const F6_ANCHORED_MISUSE: &str = r#"# Anchored misuse: committed trigger, nullable hop, scalar parent.
app Shop
Given
 Community { name:text }
 Opportunity in Community { title:text }
 Signup in Opportunity { email:text }
 event Maybe { opportunity:Opportunity?, reason:text }
When
 scenario committed_anchor on=Opportunity.updated each=event.opportunity.Signup as signup
  do
   let x=1
 scenario nullable_hop on=Maybe each=event.opportunity.Signup as signup
  do
   let x=1
 scenario scalar_parent on=Maybe each=event.reason.Signup as signup
  do
   let x=1
Then
"#;

#[test]
fn f6_anchored_misuse_diagnosed() {
    let catalog = fixture();
    let (tables, effects, diags) = run(F6_ANCHORED_MISUSE, Some(&catalog));
    let mut messages: Vec<&str> = e4055(&diags).iter().map(|(m, _, _)| *m).collect();
    messages.sort();
    assert_eq!(
        messages,
        vec![
            "unsupported each= cohort: anchored collections need on=DeclaredEvent carrying the parent record",
            "unsupported each= cohort: parent `event.opportunity` is nullable, anchored cohorts need one pinned parent record",
            "unsupported each= cohort: parent `event.reason` is not a record",
        ],
        "all diagnostics: {diags:?}"
    );
    for name in [
        "Shop.committed_anchor",
        "Shop.nullable_hop",
        "Shop.scalar_parent",
    ] {
        let body = effects
            .scenarios
            .get(&tables.by_canonical[name])
            .expect(name);
        assert!(body.cohort.is_none(), "{name} emits no descriptor");
    }
}

const F6_UNKNOWN_TRIGGER: &str = r#"# each= with an undecoded trigger stands down (fix-and-reveal).
app Shop
Given
 Todo { title:text }
When
 scenario sweep on=Nosuch each=Todo as todo
  do
   let x=1
Then
"#;

#[test]
fn f6_undecoded_trigger_stands_down() {
    let catalog = fixture();
    let (_, _, diags) = run(F6_UNKNOWN_TRIGGER, Some(&catalog));
    assert!(
        e4055(&diags).is_empty(),
        "undecoded on= is an earlier finding; F6 stays silent: {diags:?}"
    );
    assert!(
        diags.iter().any(|d| d.code != "E4055"),
        "the trigger itself still fails: {diags:?}"
    );
}

const F6_BOUNDED_LOOP: &str = r#"# Ordinary bounded loops keep their existing rules beside each=.
app Shop
Given
 Todo { title:text }
 event Ping {}
When
 scenario sweep on=Ping each=Todo as todo
  do
   for item in Todo limit=100
    let x=1
 scenario bad_limit on=Ping
  do
   for item in Todo limit=0
    let x=1
Then
"#;

#[test]
fn f6_bounded_loop_rules_retained() {
    let catalog = fixture();
    let (_, _, diags) = run(F6_BOUNDED_LOOP, Some(&catalog));
    // The fanout scenario carries only the standing parser marker; the
    // bad limit still fails under the existing types rule (E3001).
    assert_eq!(
        codes(&diags),
        vec!["E1203", "E3001"],
        "all diagnostics: {diags:?}"
    );
    assert!(
        diags
            .iter()
            .any(|d| d.code == "E3001" && d.message.contains("for limit must be positive")),
        "bad limit finding: {diags:?}"
    );
}

#[test]
fn f6_draft_bodies_accepted_without_trimming() {
    // M9: the four real each= sites (read-only draft reads) carry valid
    // cohorts and draw zero E4055 — valid bodies stay clean of new
    // findings. Pre-existing cascades (E1203 + the resolve join's
    // unbound-binding E2001/E2013/E3001s) are untouched; exact corpus
    // totals stay pinned by the read-only draft_outcome_table test.
    use effects::CohortKind;
    let catalog = fixture();
    for (file, scenarios) in [
        (
            "CanShift.can",
            vec![
                (
                    "shift.review_commitment",
                    CohortKind::Model,
                    "shift.Commitment",
                    "commitment",
                ),
                ("shift.review_swap", CohortKind::Model, "shift.Swap", "swap"),
            ],
        ),
        (
            "CanVolunteer.can",
            vec![
                (
                    "volunteer.refresh_reminders",
                    CohortKind::Model,
                    "volunteer.Signup",
                    "signup",
                ),
                (
                    "volunteer.cancel_signup",
                    CohortKind::AnchoredCollection,
                    "volunteer.Signup",
                    "signup",
                ),
            ],
        ),
    ] {
        let src = draft(file);
        let (tables, effects, diags) = run(&src, Some(&catalog));
        assert!(
            e4055(&diags).is_empty(),
            "{file} must draw zero E4055, got {:?}",
            e4055(&diags)
        );
        for (scenario, kind, model, bind) in scenarios {
            let id = tables.by_canonical[scenario];
            let body = effects.scenarios.get(&id).expect(scenario);
            let cohort = body.cohort.as_ref().expect(scenario);
            assert_eq!(cohort.kind, kind, "{scenario} kind");
            assert_eq!(cohort.model, tables.by_canonical[model], "{scenario} model");
            assert_eq!(cohort.bind.as_deref(), Some(bind), "{scenario} bind");
        }
        let cancel = tables.by_canonical["volunteer.cancel_signup"];
        if effects.scenarios.contains_key(&cancel) {
            let cohort = effects.scenarios[&cancel]
                .cohort
                .as_ref()
                .expect("cancel cohort");
            assert_eq!(cohort.parent_path, vec!["event", "opportunity"]);
        }
    }
}
