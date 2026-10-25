//! Outcome 4 (C02 owning source inventory): every checked membership call
//! and collection domain in the original program carries its exact owning
//! source/type/owner entry in the published inventory — inline, local,
//! imported and nested helpers, model/array collections, non-Boolean
//! derived fields and record-less page guards alike. No entry is invented
//! or dropped, and checked source/type/owner corruption still refuses.
//!
//! Probes use a synthetic minimal catalog (no `packages/values/dist`
//! needed): the `active_member` state-read builtin exactly as the installed
//! native catalog declares it, plus the pure builtins the shapes consume.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::types::SelectedCallTarget;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrItemKind, IrProgram};
use canlang_compiler::codegen::scenario_decisions::{
    SerialDecisionTarget, collect_decision_sources, serialize_read_decision_sources,
    serialize_read_predicate_sources,
};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

const CATALOG_JSON: &str = r#"{"language_version":"1.0","catalog_version":"0.1.0","entries":[{"id":"active_member","js":"active_member","owner":"lane-03","kind":"builtin","signature":"active_member(person:user,team:Team)->bool","effects":"state-read","availability":"external"},{"id":"any","js":"any","owner":"lane-02","kind":"builtin","signature":"any(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"},{"id":"all","js":"all","owner":"lane-02","kind":"builtin","signature":"all(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"},{"id":"count","js":"count","owner":"lane-02","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"pure","availability":"implemented"},{"id":"first","js":"first","owner":"lane-02","kind":"builtin","signature":"first(domain:ordered C<T>)->T?","effects":"pure","availability":"implemented"},{"id":"choose","js":"choose","owner":"lane-02","kind":"builtin","signature":"choose(condition:bool,yes:T,no:T)->T","effects":"pure","availability":"implemented"}]}"#;

const PATH: &str = "probe.can";

const HELPER: &str = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members where=ok(actor)\nWhen\n scenario touch(entry:Entry) by=members\n  require ok(actor)\n  do let x = 1\nThen\n page /entries title=\"Entries\"\n  list Entry as e where ok(actor)\n   text \"hi\"\n";

const IMPORTED: &str = "app Inv uses=[shop]\npackage lib\n Given\n  export derive ok(person:user?):bool = person!=null and active_member(person,team)\n When\n Then\npackage shop\n use lib {ok}\n Given\n  Entry {owner:user}\n  policy Entry read=members where=ok(actor)\n When\n  scenario touch(entry:Entry) by=members\n   require ok(actor)\n   do let x = 1\n Then\n  page /entries title=\"Entries\"\n   list Entry as e where ok(actor)\n    text \"hi\"\n";

const ANY_MODEL: &str = "app Inv uses=[shop]\npackage lib\n Given\n  export Worker {account:user,active:bool}\n  policy Worker read=members\n  export derive staff(person:user):bool = any(Worker as w,w.account==person and w.active and active_member(person,team))\n When\n Then\npackage shop\n use lib {staff}\n Given\n  Entry {owner:user}\n  policy Entry read=members where=staff(actor)\n When\n Then\n";

const NESTED: &str = "app Inv\nGiven\n Entry {owner:user}\n derive inner(person:user?):bool = person!=null and active_member(person,team)\n derive outer(person:user?):bool = person!=null and inner(person)\n policy Entry read=members where=outer(actor) and inner(actor)\nWhen\nThen\n";

const ARRAY_ANY: &str = "app Inv\nGiven\n Entry {owner:user,tags:text[]}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members where=ok(actor) and any(row.tags as t,t==\"open\" or ok(actor))\nWhen\nThen\n";

const NONBOOL_FIELD: &str = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n derive Entry.tag:text = choose(ok(row.owner),\"member\",\"guest\")\n policy Entry read=members where=ok(actor)\nWhen\nThen\n page /entries title=\"Entries\"\n  list Entry as e\n   text row.tag\n";

const UNBOUND_PAGE: &str = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members where=ok(actor)\nWhen\nThen\n page /entries title=\"Entries\"\n  require ok(actor)\n  list Entry as e\n   text \"hi\"\n";

const ROUTED_PAGE: &str = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n derive Entry.flag:bool = ok(row.owner)\n policy Entry read=members where=ok(actor)\nWhen\nThen\n page /entries/{Entry.id}/access title=\"Access\"\n  require actor!=null and ok(actor)\n  text row.flag\n";

fn load_test_catalog() -> (tempfile::TempDir, Catalog) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    std::fs::write(&path, CATALOG_JSON).unwrap();
    let mut anchor = SourceDb::new();
    let id = anchor.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: dir.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (dir, catalog.unwrap())
}

fn load_catalog_text(entries: &str) -> (tempfile::TempDir, Catalog) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    let document =
        format!(r#"{{"language_version":"1.0","catalog_version":"0.1.0","entries":[{entries}]}}"#);
    std::fs::write(&path, document).unwrap();
    let mut anchor = SourceDb::new();
    let id = anchor.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: dir.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (dir, catalog.unwrap())
}

struct Fixture {
    db: SourceDb,
    program: CheckedProgram,
    ir: IrProgram,
    sha: String,
}

fn build_fixture(source: &str, catalog: &Catalog) -> Fixture {
    let mut db = SourceDb::new();
    let id = db.add(PATH.into(), source.into());
    let (program, diagnostics) = check_program(&db, &[id], Some(catalog));
    assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(catalog));
    assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
    Fixture {
        db,
        program,
        ir,
        sha: sha256_hex(source.as_bytes()),
    }
}

fn membership_calls(program: &CheckedProgram) -> usize {
    program
        .types
        .selected_calls
        .iter()
        .filter(|(_, call)| {
            matches!(&call.target, SelectedCallTarget::Builtin { id, overload: 0 } if id == "active_member")
        })
        .count()
}

fn call_targets(
    site: &canlang_compiler::codegen::scenario_decisions::SerialDecisionSite,
) -> Vec<String> {
    site.calls
        .iter()
        .map(|call| match &call.target {
            SerialDecisionTarget::Builtin { id, overload } => format!("builtin:{id}#{overload}"),
            SerialDecisionTarget::Derive { name } => format!("derive:{name}"),
            SerialDecisionTarget::Role { name } => format!("role:{name}"),
        })
        .collect()
}

fn assert_source(
    source: &canlang_compiler::codegen::scenario_decisions::SerialDecisionSource,
    sha: &str,
    module: &str,
) {
    assert_eq!(source.path, PATH, "owning path");
    assert_eq!(source.sha256, sha, "owning source digest");
    assert_eq!(source.module, module, "owning module");
}

/// Every read rule publishes its decision inventory with exact owning
/// sources; the helper-transitive membership chain is never dropped and
/// no entry is invented.
fn assert_policy_inventory(
    fixture: &Fixture,
    catalog: &Catalog,
    rule_id: &str,
    module: &str,
    chains: &[Vec<(&str, &str)>],
) {
    let rule = fixture
        .ir
        .read_rules
        .iter()
        .chain(&fixture.ir.callback_read_rules)
        .find(|candidate| candidate.id == rule_id)
        .unwrap();
    let sites = serialize_read_decision_sources(
        &fixture.program,
        &fixture.ir,
        rule,
        &fixture.db,
        Some(catalog),
    )
    .unwrap_or_else(|| panic!("policy inventory refuses a valid rule: {rule:?}"));
    assert_eq!(
        sites.len(),
        chains.len(),
        "no invented or dropped policy sites: {sites:?}"
    );
    for (site, expected) in sites.iter().zip(chains) {
        assert_eq!(site.stage, "read-policy");
        assert_source(&site.source, &fixture.sha, module);
        assert!(
            site.node.start >= site.statement.start && site.node.end <= site.statement.end,
            "site node belongs to its statement: {site:?}"
        );
        let targets = call_targets(site);
        let expected_targets: Vec<String> = expected
            .iter()
            .map(|(target, _)| target.to_string())
            .collect();
        assert_eq!(targets, expected_targets, "exact helper-transitive chain");
        assert_eq!(site.calls.len(), expected.len());
        for (call, (_, call_module)) in site.calls.iter().zip(expected.iter()) {
            assert_source(&call.source, &fixture.sha, call_module);
        }
    }
}

fn emit_js(fixture: &Fixture, catalog: &Catalog) -> (String, Vec<String>) {
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    use canlang_compiler::diagnostic::DiagnosticResult;
    let mut result = DiagnosticResult::new("owning-inventory", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&fixture.db);
    result.complete = true;
    let mut options = EmitOptions::new();
    options.native_scenario_receipts = true;
    let (artifact, diagnostics) = emit(
        &fixture.program,
        &EmitSources {
            db: &fixture.db,
            result: &result,
            catalog: Some(catalog),
            options,
        },
    );
    let codes: Vec<String> = diagnostics
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect();
    (artifact.modules[0].js.clone(), codes)
}

fn membership_sites(emitted: &str) -> Option<serde_json::Value> {
    let line = emitted
        .lines()
        .find(|line| line.starts_with("export function canMembershipSources()"))?;
    let prefix = "export function canMembershipSources(){return JSON.parse(";
    let inner = line.strip_prefix(prefix)?.strip_suffix(");}")?;
    let encoded: String = serde_json::from_str(inner).ok()?;
    serde_json::from_str(&encoded).ok()
}

/// The published `canMembershipSources` map carries exactly the expected
/// owners, each entry in the State validator's closed shape with exact
/// owning sources and no unsupported lowering markers.
fn assert_membership_owners(
    fixture: &Fixture,
    catalog: &Catalog,
    source: &str,
    expected_owners: &[&str],
) -> serde_json::Value {
    let (emitted, codes) = emit_js(fixture, catalog);
    assert!(
        codes.iter().all(|code| code.starts_with("E6007")),
        "no unsupported lowering, only external-producer notes: {codes:?}\n{source}"
    );
    for marker in [
        "unsupported membership source identity",
        "unsupported Boolean observer",
        "unsupported helper membership occurrence",
    ] {
        assert!(
            !emitted.contains(marker),
            "valid membership reads lower with owning sources: {marker}"
        );
    }
    let sites = membership_sites(&emitted).expect("published owning inventory");
    let mut owners: Vec<String> = sites
        .as_object()
        .expect("owner map")
        .keys()
        .cloned()
        .collect();
    owners.sort();
    let mut expected: Vec<String> = expected_owners.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(owners, expected, "no invented or dropped owners");
    for (owner, entries) in sites.as_object().unwrap() {
        for entry in entries.as_array().unwrap() {
            let map = entry.as_object().unwrap();
            let mut keys: Vec<&str> = map.keys().map(|key| key.as_str()).collect();
            keys.sort();
            assert_eq!(
                keys,
                [
                    "calls",
                    "node",
                    "owner",
                    "position",
                    "source",
                    "stage",
                    "statement",
                    "version"
                ],
                "closed State inventory shape for {owner}"
            );
            assert_eq!(map["version"].as_u64(), Some(1));
            assert_eq!(map["owner"].as_str(), Some(owner.as_str()));
            assert_eq!(map["position"], serde_json::Value::Array(Vec::new()));
            assert!(
                matches!(
                    map["stage"].as_str(),
                    Some("read-policy" | "read-predicate")
                ),
                "closed stage for {owner}"
            );
            let entry_source = &map["source"];
            assert_eq!(entry_source["path"].as_str(), Some(PATH));
            assert_eq!(entry_source["sha256"].as_str(), Some(fixture.sha.as_str()));
            assert!(entry_source["module"].is_string(), "{owner}");
            for call in map["calls"].as_array().unwrap() {
                assert_eq!(call["source"]["path"].as_str(), Some(PATH));
                assert_eq!(
                    call["source"]["sha256"].as_str(),
                    Some(fixture.sha.as_str())
                );
                for frame in call["chain"].as_array().unwrap() {
                    assert_eq!(frame["source"]["path"].as_str(), Some(PATH));
                    assert_eq!(
                        frame["source"]["sha256"].as_str(),
                        Some(fixture.sha.as_str())
                    );
                }
            }
        }
    }
    sites
}

#[test]
fn helper_shapes_carry_exact_owning_sources() {
    let (_dir, catalog) = load_test_catalog();
    for (source, module, helper, defining) in [
        (HELPER, "Inv", "Inv.ok", "Inv"),
        (IMPORTED, "shop", "lib.ok", "lib"),
    ] {
        let fixture = build_fixture(source, &catalog);
        assert_eq!(membership_calls(&fixture.program), 1);
        let derive = format!("derive:{helper}");
        assert_policy_inventory(
            &fixture,
            &catalog,
            "Entry.read.1",
            module,
            &[
                vec![],
                vec![
                    (derive.as_str(), module),
                    ("builtin:active_member#0", defining),
                ],
            ],
        );
        let predicates = serialize_read_predicate_sources(
            &fixture.program,
            &fixture.ir,
            &fixture.db,
            Some(&catalog),
        )
        .expect("page predicate inventory");
        assert_eq!(predicates.len(), 1, "{source}");
        assert_eq!(predicates[0].stage, "read-predicate");
        assert_source(&predicates[0].source, &fixture.sha, module);
        assert_eq!(
            call_targets(&predicates[0]),
            vec![
                format!("derive:{helper}"),
                "builtin:active_member#0".to_string()
            ]
        );
        let scenarios: Vec<_> = fixture
            .ir
            .items
            .iter()
            .filter(|item| matches!(item.kind, IrItemKind::Scenario { .. }))
            .collect();
        assert_eq!(scenarios.len(), 1);
        let sites = collect_decision_sources(
            &fixture.program,
            &fixture.ir,
            scenarios[0],
            &fixture.db,
            Some(&catalog),
        )
        .expect("scenario decision inventory");
        assert!(!sites.is_empty(), "{source}");
    }
}

#[test]
fn collection_shapes_carry_owning_sources() {
    let (_dir, catalog) = load_test_catalog();
    let fixture = build_fixture(ANY_MODEL, &catalog);
    assert_policy_inventory(
        &fixture,
        &catalog,
        "Entry.read.1",
        "shop",
        &[
            vec![],
            vec![
                ("derive:lib.staff", "shop"),
                ("builtin:active_member#0", "lib"),
                ("builtin:any#0", "lib"),
            ],
        ],
    );
    let nested = build_fixture(NESTED, &catalog);
    assert_policy_inventory(
        &nested,
        &catalog,
        "Entry.read.1",
        "Inv",
        &[
            vec![],
            vec![
                ("derive:Inv.outer", "Inv"),
                ("derive:Inv.inner", "Inv"),
                ("builtin:active_member#0", "Inv"),
                ("derive:Inv.inner", "Inv"),
                ("builtin:active_member#0", "Inv"),
            ],
        ],
    );
    let array = build_fixture(ARRAY_ANY, &catalog);
    assert_policy_inventory(
        &array,
        &catalog,
        "Entry.read.1",
        "Inv",
        &[
            vec![],
            vec![
                ("derive:Inv.ok", "Inv"),
                ("builtin:active_member#0", "Inv"),
                ("derive:Inv.ok", "Inv"),
                ("builtin:active_member#0", "Inv"),
                ("builtin:any#0", "Inv"),
            ],
        ],
    );
}

#[test]
fn nonbool_derived_field_publishes_owning_source() {
    let (_dir, catalog) = load_test_catalog();
    let fixture = build_fixture(NONBOOL_FIELD, &catalog);
    let sites = assert_membership_owners(
        &fixture,
        &catalog,
        NONBOOL_FIELD,
        &["Inv.Entry.read.1", "Inv.Entry.tag"],
    );
    let tag = &sites["Inv.Entry.tag"];
    let entries = tag.as_array().unwrap();
    assert_eq!(
        entries.len(),
        1,
        "one field site, never duplicated: {entries:?}"
    );
    let entry = &entries[0];
    assert_eq!(entry["stage"].as_str(), Some("read-predicate"));
    assert_eq!(entry["owner"].as_str(), Some("Inv.Entry.tag"));
    let calls: Vec<String> = entry["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| {
            let target = &call["target"];
            if target["kind"].as_str() == Some("builtin") {
                format!(
                    "builtin:{}#{}",
                    target["id"].as_str().unwrap(),
                    target["overload"].as_u64().unwrap()
                )
            } else {
                format!("derive:{}", target["name"].as_str().unwrap())
            }
        })
        .collect();
    assert_eq!(
        calls,
        vec![
            "derive:Inv.ok",
            "builtin:active_member#0",
            "builtin:choose#0"
        ]
    );
}

#[test]
fn unbound_page_require_publishes_owning_source_without_model() {
    let (_dir, catalog) = load_test_catalog();
    let fixture = build_fixture(UNBOUND_PAGE, &catalog);
    let sites = assert_membership_owners(
        &fixture,
        &catalog,
        UNBOUND_PAGE,
        &["Inv.Entry.read.1", "Inv.InvEntriesPage"],
    );
    let page = &sites["Inv.InvEntriesPage"];
    let entries = page.as_array().unwrap();
    assert_eq!(entries.len(), 1, "one guard site: {entries:?}");
    let entry = &entries[0];
    assert_eq!(entry["stage"].as_str(), Some("read-predicate"));
    assert_eq!(entry["owner"].as_str(), Some("Inv.InvEntriesPage"));
    assert!(
        entry.get("model").is_none(),
        "no invented row owner: {entry:?}"
    );
    let calls: Vec<String> = entry["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| {
            let target = &call["target"];
            if target["kind"].as_str() == Some("builtin") {
                format!(
                    "builtin:{}#{}",
                    target["id"].as_str().unwrap(),
                    target["overload"].as_u64().unwrap()
                )
            } else {
                format!("derive:{}", target["name"].as_str().unwrap())
            }
        })
        .collect();
    assert_eq!(calls, vec!["derive:Inv.ok", "builtin:active_member#0"]);
}

#[test]
fn routed_page_require_inventory_unchanged() {
    let (_dir, catalog) = load_test_catalog();
    let fixture = build_fixture(ROUTED_PAGE, &catalog);
    assert_membership_owners(
        &fixture,
        &catalog,
        ROUTED_PAGE,
        &[
            "Inv.Entry.flag",
            "Inv.Entry.read.1",
            "Inv.InvEntriesEntryidAccessPage",
        ],
    );
}

#[test]
fn tampered_source_refuses_inventory() {
    let (_dir, catalog) = load_test_catalog();
    let fixture = build_fixture(HELPER, &catalog);
    let tampered = HELPER.replacen("app Inv", "app  Inv", 1);
    assert_ne!(tampered, HELPER);
    let mut db = SourceDb::new();
    let id = db.add(PATH.into(), tampered);
    let (program, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let rule = fixture
        .ir
        .read_rules
        .iter()
        .find(|rule| rule.id == "Entry.read.1")
        .unwrap();
    assert!(
        serialize_read_decision_sources(&program, &fixture.ir, rule, &db, Some(&catalog)).is_none(),
        "shifted source bytes refuse the policy inventory"
    );
    assert!(
        serialize_read_predicate_sources(&program, &fixture.ir, &db, Some(&catalog)).is_none(),
        "shifted source bytes refuse the predicate inventory"
    );
}

#[test]
fn mismatched_program_and_ir_refuse_inventory() {
    let (_dir, catalog) = load_test_catalog();
    let helper = build_fixture(HELPER, &catalog);
    let imported = build_fixture(IMPORTED, &catalog);
    let rule = imported
        .ir
        .read_rules
        .iter()
        .find(|rule| rule.id == "Entry.read.1")
        .unwrap();
    assert!(
        serialize_read_decision_sources(
            &helper.program,
            &imported.ir,
            rule,
            &imported.db,
            Some(&catalog)
        )
        .is_none(),
        "foreign owning program refuses"
    );
    assert!(
        serialize_read_predicate_sources(
            &helper.program,
            &imported.ir,
            &imported.db,
            Some(&catalog)
        )
        .is_none(),
        "foreign owning program refuses predicates"
    );
}

#[test]
fn forged_catalog_signature_refuses_membership() {
    let entries = r#"{"id":"active_member","js":"active_member","owner":"lane-03","kind":"builtin","signature":"active_member(person:text,team:Team)->bool","effects":"state-read","availability":"external"}"#;
    let (_dir, catalog) = load_catalog_text(entries);
    let mut db = SourceDb::new();
    let id = db.add(PATH.into(), HELPER.into());
    let (program, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3010"),
        "forged person type refuses checking: {diagnostics:?}"
    );
    let (ir, _) = ir::build(&program, &db, Some(&catalog));
    let rule = ir
        .read_rules
        .iter()
        .chain(&ir.callback_read_rules)
        .next()
        .cloned();
    if let Some(rule) = rule {
        assert!(
            serialize_read_decision_sources(&program, &ir, &rule, &db, Some(&catalog)).is_none(),
            "forged types refuse the inventory"
        );
    }
}
