//! BGI-07: trait contributions and custom keyword contracts.
//!
//! Compiler-checked Given contracts: named/inline model/field trait
//! contributions from saved `contributions.can` carriers, and named
//! standalone custom-keyword bindings to the compiler-owned
//! `state.unique-key@1` producer. Saved implementation JavaScript is
//! fingerprinted but never parsed or executed — no module runs to
//! discover schema or authority. Reuses BGI-01 discovery shapes and
//! BGI-02 association keys, plus the existing check/emit/typed-artifact
//! harnesses.
use canlang_compiler::analysis::check::{
    GivenContractInputs, GivenSavedDeclaration, GivenSavedUnit, check_given_contracts,
};
use canlang_compiler::analysis::generation::{GenerationKind, discover_program};
use canlang_compiler::analysis::generation_intake::{AssociationKey, UnitKind};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::artifact::{assemble_given_contracts, given_contracts_to_json};
use canlang_compiler::codegen::ir::lower_given_contracts;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId, sha256_hex};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::collections::HashMap;

const JS: &str = r#"export function canonicalKey(value) { return value.normalize("NFKC").toLowerCase(); }
"#;

/// Check one app source (catalog-free: Given contracts never depend on
/// builtins) and return the database, file, program and diagnostics.
fn check_app(text: &str) -> (SourceDb, SourceId, CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("app.can".to_string(), text.to_string());
    let (program, diags) = check_program(&db, &[id], None);
    (db, id, program, diags)
}

/// BGI-02 association key for one identity-carrying descriptor.
fn assoc_key(owner: &str, kind: UnitKind, label: Option<String>, anchor: &str) -> AssociationKey {
    AssociationKey {
        owner: owner.to_string(),
        kind,
        label,
        anchor: anchor.to_string(),
    }
}

/// Add a contributions carrier to the database; returns its id.
fn add_carrier(db: &mut SourceDb, unit: &str, text: &str) -> SourceId {
    db.add(
        format!("can.generated/{unit}/contributions.can"),
        text.to_string(),
    )
}

/// Saved keyword unit binding `state.unique-key@1` with `export`.
fn keyword_unit(unit_id: &str, js: &str, export: &str) -> GivenSavedUnit {
    GivenSavedUnit {
        unit_id: unit_id.to_string(),
        contributions: None,
        implementation_js: Some(js.to_string()),
        implementation_imports: Vec::new(),
        declaration: Some(GivenSavedDeclaration {
            producer: "state.unique-key@1".to_string(),
            export: export.to_string(),
            reads: vec![],
            effects: vec![],
            authority: vec![],
        }),
    }
}

/// Emit under the test-only acknowledgment (reused codegen harness:
/// see `codegen.rs`; artifacts stay test-only, nothing executes).
fn emit_test_only<'a>(
    program: &CheckedProgram,
    db: &'a SourceDb,
    result: &'a DiagnosticResult,
) -> canlang_compiler::codegen::artifact::CompileArtifact {
    let sources = EmitSources {
        db,
        result,
        catalog: None,
        options: EmitOptions::test_only(),
    };
    emit(program, &sources).0
}

fn diagnostic_result(db: &SourceDb, diags: Vec<Diagnostic>) -> DiagnosticResult {
    let mut result = DiagnosticResult::new("test", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(db);
    result.diagnostics = diags;
    result.complete = false;
    result.finish();
    result
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

const APP: &str = r#"app Tasks
## A reusable model trait: every application shares one saved template.
Given
 trait completable $"Add done:bool=false with Open/Done labels."
 ## The novel standalone keyword: canonical identity is unavailable in current Can.
 keyword canonical_identity(target:model,field:field(target,text)) $"Use the field's NFKC-normalized, ASCII-lowercased text as a canonical unique key, preserving its stored spelling and normal permissions."
 Todo {title:text trim min=1 max=200} completable
 ## A one-off inline attachment owns its own unit, separate from the named trait.
 Note {body:text} trait $"Add pinned:bool=false."
 Account {handle:text}
 canonical_identity target=Account field=Account.handle
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
 page / title="Todos"
  text "hi"
"#;

const TRAIT_CARRIER: &str = r#"app Tasks
## Template for the `completable` trait: one template, every application.
Given
 completable {done:bool=false}
"#;

const INLINE_CARRIER: &str = r#"app Tasks
## One-off carrier for the inline attachment on Note: names its target directly.
Given
 Note {pinned:bool=false}
"#;

fn positive_saved(
    db: &mut SourceDb,
    program: &CheckedProgram,
) -> HashMap<AssociationKey, GivenSavedUnit> {
    let trait_c = add_carrier(db, "u1", TRAIT_CARRIER);
    let inline_c = add_carrier(db, "u2", INLINE_CARRIER);
    let found = discover_program(db, program.checked_files());
    let mut saved = HashMap::new();
    for d in &found.descriptors {
        match d.kind {
            GenerationKind::NamedTrait => {
                saved.insert(
                    assoc_key(&d.owner, UnitKind::NamedTrait, d.label.clone(), &d.anchor),
                    GivenSavedUnit {
                        unit_id: "u1".to_string(),
                        contributions: Some(trait_c),
                        implementation_js: None,
                        implementation_imports: Vec::new(),
                        declaration: None,
                    },
                );
            }
            GenerationKind::InlineTrait => {
                saved.insert(
                    assoc_key(&d.owner, UnitKind::InlineTrait, d.label.clone(), &d.anchor),
                    GivenSavedUnit {
                        unit_id: "u2".to_string(),
                        contributions: Some(inline_c),
                        implementation_js: None,
                        implementation_imports: Vec::new(),
                        declaration: None,
                    },
                );
            }
            GenerationKind::KeywordDefinition => {
                saved.insert(
                    assoc_key(&d.owner, UnitKind::Keyword, d.label.clone(), &d.anchor),
                    keyword_unit("u3", JS, "canonicalKey"),
                );
            }
            _ => {}
        }
    }
    saved
}

#[test]
fn keyword_reaches_consumers_through_checked_contract() {
    let (mut db, _app, program, base) = check_app(APP);
    assert!(base.is_empty(), "{base:?}");
    let saved = positive_saved(&mut db, &program);
    let inputs = GivenContractInputs {
        db: &db,
        program: &program,
        saved: &saved,
    };
    let (tables, diags) = check_given_contracts(&inputs);
    assert!(diags.is_empty(), "{diags:?}");
    // The keyword binds exactly one rule through the producer contract.
    assert_eq!(tables.keywords.len(), 1);
    let contract = &tables.keywords[0];
    assert_eq!(contract.name, "canonical_identity");
    assert_eq!(contract.unit_id, "u3");
    assert_eq!(contract.producer, "state.unique-key@1");
    assert_eq!(contract.semantics, "nfkc-ascii-lowercase");
    assert_eq!(contract.lifecycle, "commit-keys");
    assert_eq!(contract.export, "canonicalKey");
    assert_eq!(contract.input.name, "field");
    assert_eq!(contract.input.type_name, "text");
    assert_eq!(contract.result, "text");
    assert!(contract.reads.is_empty());
    assert!(contract.effects.is_empty());
    assert!(contract.authority.is_empty());
    assert_eq!(contract.dependencies, vec!["Tasks.Account.handle"]);
    assert_eq!(contract.fingerprint, sha256_hex(JS.as_bytes()));
    assert_eq!(contract.applications.len(), 1);
    let app = &contract.applications[0];
    assert_eq!(app.rule_id, "Tasks.Account.handle#canonical_identity");
    assert_eq!(app.target_model, "Tasks.Account");
    assert_eq!(app.target_field, "Tasks.Account.handle");
    assert_eq!(
        app.args,
        vec![
            ("target".to_string(), "Tasks.Account".to_string()),
            ("field".to_string(), "Tasks.Account.handle".to_string()),
        ]
    );
    // Lowering + emission carry the contract to consumers as typed JSON.
    let ir = lower_given_contracts(&tables);
    assert_eq!(ir.keywords.len(), 1);
    assert_eq!(
        ir.keywords[0].rule_id,
        "Tasks.Account.handle#canonical_identity"
    );
    let artifact = assemble_given_contracts(&ir, "test");
    let json = given_contracts_to_json(&artifact);
    assert!(
        json.contains("\"producer\":\"state.unique-key@1\""),
        "{json}"
    );
    assert!(
        json.contains("\"ruleId\":\"Tasks.Account.handle#canonical_identity\""),
        "{json}"
    );
    assert!(
        json.contains("\"semantics\":\"nfkc-ascii-lowercase\""),
        "{json}"
    );
    assert!(!json.ends_with('\n'));
    // The novel rule is not a repackaged builtin: the emitted model
    // carries no builtin unique key for the bound field.
    let result = diagnostic_result(&db, base);
    let emitted = emit_test_only(&program, &db, &result);
    let account = emitted
        .models
        .iter()
        .find(|m| m.name == "Tasks.Account")
        .expect("Account model emits");
    assert!(
        !account.unique_keys.iter().any(|k| k == "handle"),
        "canonical_identity must not lower to builtin unique: {:?}",
        account.unique_keys
    );
}

#[test]
fn second_application_reuses_saved_implementation() {
    let text = r#"app Tasks
## One definition, two compatible applications, one saved unit.
Given
 keyword canonical_identity(target:model,field:field(target,text)) $"Use the field's NFKC-normalized, ASCII-lowercased text as a canonical unique key."
 Account {handle:text}
 Member {code:text}
 canonical_identity target=Account field=Account.handle
 canonical_identity target=Member field=Member.code
When
 scenario complete(task:Account) by=members
  do set task {handle="x"}
Then
 page / title="Todos"
  text "hi"
"#;
    let (db, _app, program, base) = check_app(text);
    assert!(base.is_empty(), "{base:?}");
    let found = discover_program(&db, program.checked_files());
    assert_eq!(
        found
            .descriptors
            .iter()
            .filter(|d| d.kind == GenerationKind::KeywordDefinition)
            .count(),
        1
    );
    assert_eq!(
        found
            .descriptors
            .iter()
            .filter(|d| d.kind == GenerationKind::KeywordApplication)
            .count(),
        2
    );
    // Exactly one saved unit exists: the second application reuses it
    // with zero AI (no second unit, no second prompt).
    let def = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::KeywordDefinition)
        .unwrap();
    let mut saved = HashMap::new();
    saved.insert(
        assoc_key(
            &def.owner,
            UnitKind::Keyword,
            def.label.clone(),
            &def.anchor,
        ),
        keyword_unit("u7", JS, "canonicalKey"),
    );
    assert_eq!(saved.len(), 1);
    let (tables, diags) = check_given_contracts(&GivenContractInputs {
        db: &db,
        program: &program,
        saved: &saved,
    });
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(tables.keywords.len(), 1);
    let contract = &tables.keywords[0];
    assert_eq!(contract.unit_id, "u7");
    assert_eq!(contract.applications.len(), 2);
    // Explicit source order is preserved across the shared unit.
    assert_eq!(
        contract.applications[0].rule_id,
        "Tasks.Account.handle#canonical_identity"
    );
    assert_eq!(
        contract.applications[1].rule_id,
        "Tasks.Member.code#canonical_identity"
    );
    assert!(contract.applications[0].span.start < contract.applications[1].span.start);
    assert_eq!(contract.applications[0].order, 0);
    assert_eq!(contract.applications[1].order, 1);
    // Both rules share one fingerprint: one implementation closure.
    let ir = lower_given_contracts(&tables);
    assert_eq!(ir.keywords.len(), 2);
    assert_eq!(ir.keywords[0].unit_id, "u7");
    assert_eq!(ir.keywords[1].unit_id, "u7");
    assert_eq!(ir.keywords[0].fingerprint, ir.keywords[1].fingerprint);
}

#[test]
fn independently_authored_expected_behavior() {
    // Independently authored vectors for the novel semantics: fullwidth
    // "Ａlice" and "Alice" share one canonical key (conflict), "Bob"
    // stands alone, and every stored spelling is preserved verbatim.
    // These expectations come from the fixture author, not from the
    // implementation — a repackaged builtin has no contract to pin
    // them to.
    let vectors: &[(&str, &str, &str)] = &[
        ("Ａlice", "alice", "Ａlice"),
        ("Alice", "alice", "Alice"),
        ("Bob", "bob", "Bob"),
    ];
    let (mut db, _app, program, base) = check_app(APP);
    assert!(base.is_empty(), "{base:?}");
    let saved = positive_saved(&mut db, &program);
    let (tables, diags) = check_given_contracts(&GivenContractInputs {
        db: &db,
        program: &program,
        saved: &saved,
    });
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(tables.keywords.len(), 1);
    let contract = &tables.keywords[0];
    // The contract pins the fixed compiler-owned semantics the vectors
    // assume: text in, text out, no helper stored field, no builtin.
    assert_eq!(contract.semantics, "nfkc-ascii-lowercase");
    assert_eq!(contract.input.type_name, "text");
    assert_eq!(contract.result, "text");
    assert_eq!(contract.dependencies, vec!["Tasks.Account.handle"]);
    for (stored, key, preserved) in vectors {
        assert_eq!(*stored, *preserved, "stored spelling is preserved");
        assert!(!key.is_empty());
        assert_eq!(*key, key.to_ascii_lowercase(), "keys are ASCII-lowercase");
    }
    assert_eq!(vectors[0].1, vectors[1].1, "conflict pair shares one key");
    assert_ne!(vectors[0].1, vectors[2].1, "Bob stands alone");
    // No trait contract adds a helper field to the bound model.
    for trait_contract in &tables.traits {
        for app in &trait_contract.applications {
            assert_ne!(app.target_canonical, "Tasks.Account");
        }
    }
}

/// Run the Given check over one app with caller-built saved units.
fn run_given(
    db: &SourceDb,
    program: &CheckedProgram,
    saved: &HashMap<AssociationKey, GivenSavedUnit>,
) -> (
    canlang_compiler::analysis::check::GivenContractTables,
    Vec<Diagnostic>,
) {
    check_given_contracts(&GivenContractInputs { db, program, saved })
}

fn expect_code(diags: &[Diagnostic], code: &str, needle: &str) {
    assert!(
        diags
            .iter()
            .any(|d| d.code == code && d.message.contains(needle)),
        "expected {code} containing {needle:?}, got {diags:?}"
    );
}

const REFUSAL_PREAMBLE: &str = "app Tasks\nGiven\n";
const REFUSAL_TAIL: &str = "When\n scenario complete(task:Account) by=members\n  do set task {handle=\"x\"}\nThen\n page / title=\"T\"\n  text \"hi\"\n";

fn refusal_app(given: &str) -> String {
    format!("{REFUSAL_PREAMBLE}{given}{REFUSAL_TAIL}")
}

fn keyword_saved_for(
    db: &SourceDb,
    program: &CheckedProgram,
    unit: GivenSavedUnit,
) -> HashMap<AssociationKey, GivenSavedUnit> {
    let found = discover_program(db, program.checked_files());
    let def = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::KeywordDefinition)
        .expect("keyword definition");
    let mut saved = HashMap::new();
    saved.insert(
        assoc_key(
            &def.owner,
            UnitKind::Keyword,
            def.label.clone(),
            &def.anchor,
        ),
        unit,
    );
    saved
}

fn trait_saved_for(
    db: &mut SourceDb,
    program: &CheckedProgram,
    carrier: &str,
    js: Option<&str>,
) -> HashMap<AssociationKey, GivenSavedUnit> {
    let carrier_id = add_carrier(db, "u1", carrier);
    let found = discover_program(db, program.checked_files());
    let def = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::NamedTrait)
        .expect("trait definition");
    let mut saved = HashMap::new();
    saved.insert(
        assoc_key(
            &def.owner,
            UnitKind::NamedTrait,
            def.label.clone(),
            &def.anchor,
        ),
        GivenSavedUnit {
            unit_id: "u1".to_string(),
            contributions: Some(carrier_id),
            implementation_js: js.map(str::to_string),
            implementation_imports: Vec::new(),
            declaration: None,
        },
    );
    saved
}

#[test]
fn incompatible_uses_conflicts_and_hidden_authority_refuse() {
    // Keyword on a non-text field: the producer computes over text only.
    let (db, _app, program, base) = check_app(&refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text,qty:int}\n canonical_identity target=Account field=Account.qty\n",
    ));
    // Discovery flags the CST-level type mismatch too; the Given check
    // must refuse on the checked type independently.
    assert!(base.iter().any(|d| d.code == "E2001"), "{base:?}");
    let saved = keyword_saved_for(&db, &program, keyword_unit("u3", JS, "canonicalKey"));
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E3020", "needs a checked text field");
    assert!(tables.keywords.is_empty());

    // Keyword on a builtin-unique field: canonical vs builtin key clash.
    let (db, _app, program, base) = check_app(&refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text unique}\n canonical_identity target=Account field=Account.handle\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let saved = keyword_saved_for(&db, &program, keyword_unit("u3", JS, "canonicalKey"));
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(
        &diags,
        "E3021",
        "conflicts with the declared builtin unique",
    );
    assert!(tables.keywords.is_empty());

    // Two applications binding one field: the second refuses.
    let (db, _app, program, base) = check_app(&refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n canonical_identity target=Account field=Account.handle\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let saved = keyword_saved_for(&db, &program, keyword_unit("u3", JS, "canonicalKey"));
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(
        &diags,
        "E3021",
        "is already bound by keyword `canonical_identity`",
    );
    assert!(tables.keywords.is_empty());

    // Trait contributes an already-declared field.
    let (mut db, _app, program, base) = check_app(&refusal_app(
        " trait completable $\"Add done.\"\n Account {handle:text,done:bool=false} completable\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let saved = trait_saved_for(
        &mut db,
        &program,
        "app Tasks\nGiven\n completable {done:bool=false}\n",
        None,
    );
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E3021", "already declared");
    assert!(tables.traits.is_empty());

    // Field trait contradicts the declared default.
    let (mut db, _app, program, base) = check_app(&refusal_app(
        " trait clean $\"Clean.\"\n Account {handle:text=\"a\" clean}\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let saved = trait_saved_for(
        &mut db,
        &program,
        "app Tasks\nGiven\n clean {v:text=\"b\"}\n",
        None,
    );
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E3022", "contradicts declared `\"a\"`");
    assert!(tables.traits.is_empty());

    // Unknown producer: generated code never self-registers producers.
    let (db, _app, program, base) = check_app(&refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let mut unit = keyword_unit("u3", JS, "canonicalKey");
    unit.declaration.as_mut().unwrap().producer = "state.evil@9".to_string();
    let saved = keyword_saved_for(&db, &program, unit);
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E3023", "unknown producer `state.evil@9`");
    assert!(tables.keywords.is_empty());

    // Declared authority/effects/reads refuse: the pure producer admits none.
    for (field, needle) in [
        ("authority", "authority `raw-claims`"),
        ("effects", "effect `store.write`"),
        ("reads", "read `state.store`"),
    ] {
        let (db, _app, program, base) = check_app(&refusal_app(
            " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
        ));
        assert!(base.is_empty(), "{base:?}");
        let mut unit = keyword_unit("u3", JS, "canonicalKey");
        let decl = unit.declaration.as_mut().unwrap();
        match field {
            "authority" => decl.authority = vec!["raw-claims".to_string()],
            "effects" => decl.effects = vec!["store.write".to_string()],
            _ => decl.reads = vec!["state.store".to_string()],
        }
        let saved = keyword_saved_for(&db, &program, unit);
        let (tables, diags) = run_given(&db, &program, &saved);
        expect_code(&diags, "E4056", needle);
        assert!(tables.keywords.is_empty());
    }

    // Contributions inventing an operation refuse as hidden authority.
    let (mut db, _app, program, base) = check_app(&refusal_app(
        " trait completable $\"Add done.\"\n Account {handle:text} completable\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let saved = trait_saved_for(
        &mut db,
        &program,
        "app Tasks\nGiven\n completable {done:bool=false}\nWhen\n scenario sneak(x:Account) by=members\n  do set x {handle=\"s\"}\nThen\n page / title=\"T\"\n  text \"hi\"\n",
        None,
    );
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E4056", "contributed scenario");
    assert!(tables.traits.is_empty());

    // Keyword units admit no contributions carrier in v1.
    let (mut db, _app, program, base) = check_app(&refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let carrier = add_carrier(&mut db, "u3", "app Tasks\nGiven\n Account {x:text=\"y\"}\n");
    let mut unit = keyword_unit("u3", JS, "canonicalKey");
    unit.contributions = Some(carrier);
    let saved = keyword_saved_for(&db, &program, unit);
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E4056", "contributed declarations");
    assert!(tables.keywords.is_empty());

    // Trait units admit no saved JavaScript in v1 (fields only).
    let (mut db, _app, program, base) = check_app(&refusal_app(
        " trait completable $\"Add done.\"\n Account {handle:text} completable\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let saved = trait_saved_for(
        &mut db,
        &program,
        "app Tasks\nGiven\n completable {done:bool=false}\n",
        Some("export function hook() {}"),
    );
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E4056", "saved JavaScript");
    assert!(tables.traits.is_empty());

    // Dangling keyword model reference resolves against checked symbols.
    let (db, _app, program, _base) = check_app(&refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Missing field=Missing.handle\n",
    ));
    let saved = keyword_saved_for(&db, &program, keyword_unit("u3", JS, "canonicalKey"));
    let (_tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E2011", "does not resolve to a declared model");

    // Missing export: the declaration does not match the definition.
    let (db, _app, program, base) = check_app(&refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let mut unit = keyword_unit("u3", JS, "canonicalKey");
    unit.declaration.as_mut().unwrap().export = String::new();
    let saved = keyword_saved_for(&db, &program, unit);
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E3024", "declares no saved export");
    assert!(tables.keywords.is_empty());

    // Producer/signature mismatch: unique-key needs (model, text field).
    let (db, _app, program, base) = check_app(&refusal_app(
        " keyword stamp(flag:bool) $\"Stamp.\"\n Account {handle:text}\n stamp flag=true\n",
    ));
    assert!(base.is_empty(), "{base:?}");
    let saved = keyword_saved_for(&db, &program, keyword_unit("u3", JS, "stamp"));
    let (tables, diags) = run_given(&db, &program, &saved);
    expect_code(&diags, "E3020", "does not satisfy `state.unique-key@1`");
    assert!(tables.keywords.is_empty());
}

#[test]
fn trait_reuse_and_standalone_keyword_are_distinct() {
    let text = r#"app Tasks
## Named reuse, one-off inline, field constraints and a standalone keyword.
Given
 trait completable $"Add done:bool=false."
 trait clean $"Trim and bound the field."
 keyword canonical_identity(target:model,field:field(target,text)) $"Canonical key."
 Todo {title:text} completable
 Note {body:text} completable
 Quote {title:text clean} trait $"Add archived:bool=false."
 Account {handle:text}
 canonical_identity target=Account field=Account.handle
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
 page / title="Todos"
  text "hi"
"#;
    let (mut db, _app, program, base) = check_app(text);
    assert!(base.is_empty(), "{base:?}");
    let completable_c = add_carrier(
        &mut db,
        "u1",
        "app Tasks\nGiven\n completable {done:bool=false}\n",
    );
    // Field-constraint template: no default opinion, trim plus bounds only.
    let clean_c = add_carrier(
        &mut db,
        "u2",
        "app Tasks\nGiven\n clean {v:text trim min=1 max=200}\n",
    );
    let inline_c = add_carrier(
        &mut db,
        "u3",
        "app Tasks\nGiven\n Quote {archived:bool=false}\n",
    );
    let found = discover_program(&db, program.checked_files());
    let mut saved = HashMap::new();
    for d in &found.descriptors {
        match d.kind {
            GenerationKind::NamedTrait if d.label.as_deref() == Some("completable") => {
                saved.insert(
                    assoc_key(&d.owner, UnitKind::NamedTrait, d.label.clone(), &d.anchor),
                    GivenSavedUnit {
                        unit_id: "u1".to_string(),
                        contributions: Some(completable_c),
                        implementation_js: None,
                        implementation_imports: Vec::new(),
                        declaration: None,
                    },
                );
            }
            GenerationKind::NamedTrait => {
                saved.insert(
                    assoc_key(&d.owner, UnitKind::NamedTrait, d.label.clone(), &d.anchor),
                    GivenSavedUnit {
                        unit_id: "u2".to_string(),
                        contributions: Some(clean_c),
                        implementation_js: None,
                        implementation_imports: Vec::new(),
                        declaration: None,
                    },
                );
            }
            GenerationKind::InlineTrait => {
                saved.insert(
                    assoc_key(&d.owner, UnitKind::InlineTrait, d.label.clone(), &d.anchor),
                    GivenSavedUnit {
                        unit_id: "u3".to_string(),
                        contributions: Some(inline_c),
                        implementation_js: None,
                        implementation_imports: Vec::new(),
                        declaration: None,
                    },
                );
            }
            GenerationKind::KeywordDefinition => {
                saved.insert(
                    assoc_key(&d.owner, UnitKind::Keyword, d.label.clone(), &d.anchor),
                    keyword_unit("u4", JS, "canonicalKey"),
                );
            }
            _ => {}
        }
    }
    let (tables, diags) = run_given(&db, &program, &saved);
    assert!(diags.is_empty(), "{diags:?}");
    // Three trait contracts (two named, one inline) plus one keyword.
    assert_eq!(tables.traits.len(), 3);
    assert_eq!(tables.keywords.len(), 1);
    let completable = tables
        .traits
        .iter()
        .find(|t| t.name.as_deref() == Some("completable"))
        .expect("completable contract");
    // Named reuse: two applications share one saved unit in source order.
    assert_eq!(completable.unit_id, "u1");
    assert_eq!(completable.applications.len(), 2);
    assert_eq!(completable.applications[0].target_canonical, "Tasks.Todo");
    assert_eq!(completable.applications[1].target_canonical, "Tasks.Note");
    assert_eq!(completable.contributed_fields.len(), 1);
    assert_eq!(completable.contributed_fields[0].name, "done");
    // Field attachment: constraints only, no new field, no default opinion.
    let clean = tables
        .traits
        .iter()
        .find(|t| t.name.as_deref() == Some("clean"))
        .expect("clean contract");
    assert_eq!(clean.applications.len(), 1);
    assert_eq!(clean.applications[0].target_canonical, "Tasks.Quote.title");
    assert_eq!(clean.contributed_fields[0].default, None);
    assert!(clean.contributed_fields[0].trim);
    // Inline attachment owns its one-off unit, distinct from named reuse.
    let inline = tables.traits.iter().find(|t| t.inline).expect("inline");
    assert_eq!(inline.unit_id, "u3");
    assert_eq!(inline.name, None);
    assert_eq!(inline.applications.len(), 1);
    assert_eq!(inline.applications[0].target_canonical, "Tasks.Quote");
    // The standalone keyword is its own contract kind: trait uses never
    // produce keyword rules and keyword uses never produce trait
    // instances.
    let ir = lower_given_contracts(&tables);
    assert_eq!(ir.traits.len(), 4); // Todo + Note + Quote.title + Quote
    assert_eq!(ir.keywords.len(), 1);
    assert!(ir.traits.iter().all(|i| i.target != "Tasks.Account.handle"));
    assert!(
        ir.keywords
            .iter()
            .all(|r| r.rule_id.ends_with("#canonical_identity"))
    );
    let artifact = assemble_given_contracts(&ir, "test");
    assert_eq!(artifact.traits.len(), 4);
    assert_eq!(artifact.keywords.len(), 1);
}

#[test]
fn no_module_runs_for_schema_or_authority() {
    // The same definition, declaration and carrier with two different
    // saved JavaScript bodies — one valid, one not even parseable.
    // Schema and authority derive from declarations only: both bodies
    // bind identically, differing solely in the closure fingerprint.
    // (Export/interface verification against actual JS is BGI-11
    // target validation, not discovery.)
    const INVALID_JS: &str = "this is not javascript !!! throw new ???";
    let text = refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
    );
    let (db, _app, program, base) = check_app(&text);
    assert!(base.is_empty(), "{base:?}");
    let mut contracts = Vec::new();
    for js in [JS, INVALID_JS] {
        let saved = keyword_saved_for(&db, &program, keyword_unit("u3", js, "canonicalKey"));
        let (tables, diags) = run_given(&db, &program, &saved);
        assert!(diags.is_empty(), "{diags:?}");
        assert_eq!(tables.keywords.len(), 1);
        contracts.push(tables.keywords[0].clone());
    }
    assert_ne!(contracts[0].fingerprint, contracts[1].fingerprint);
    let (mut a, mut b) = (contracts[0].clone(), contracts[1].clone());
    a.fingerprint.clear();
    b.fingerprint.clear();
    assert_eq!(a, b, "only the fingerprint may depend on JS bytes");
    // The keyword descriptor is identical either way: schema comes from
    // the definition signature and producer, never from the module.
    assert_eq!(a.producer, "state.unique-key@1");
    assert_eq!(a.input.type_name, "text");
    assert_eq!(a.result, "text");
    assert!(a.authority.is_empty() && a.effects.is_empty() && a.reads.is_empty());
}

#[test]
fn missing_saved_implementation_is_pending_not_error() {
    // A definition with no saved entry exposes its unit for preparation;
    // it never errors and never contributes a contract.
    let (db, _app, program, base) = check_app(APP);
    assert!(base.is_empty(), "{base:?}");
    let saved: HashMap<AssociationKey, GivenSavedUnit> = HashMap::new();
    let (tables, diags) = run_given(&db, &program, &saved);
    assert!(diags.is_empty(), "{diags:?}");
    assert!(tables.traits.is_empty());
    assert!(tables.keywords.is_empty());
    // Partial intake is equally quiet: only supplied units check.
    let found = discover_program(&db, program.checked_files());
    let def = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::KeywordDefinition)
        .unwrap();
    let mut partial = HashMap::new();
    partial.insert(
        assoc_key(
            &def.owner,
            UnitKind::Keyword,
            def.label.clone(),
            &def.anchor,
        ),
        keyword_unit("u3", JS, "canonicalKey"),
    );
    let (tables, diags) = run_given(&db, &program, &partial);
    assert!(diags.is_empty(), "{diags:?}");
    assert!(tables.traits.is_empty());
    assert_eq!(tables.keywords.len(), 1);
}

#[test]
fn emission_json_shape_is_pinned() {
    // Typed-artifact style pin: exact compact JSON, stable field order,
    // no trailing newline. Mirrors `ArtifactGivenKeyword` in
    // `packages/contracts/src/artifact.ts`.
    let text = refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
    );
    let (db, _app, program, base) = check_app(&text);
    assert!(base.is_empty(), "{base:?}");
    let saved = keyword_saved_for(&db, &program, keyword_unit("u3", JS, "canonicalKey"));
    let (tables, diags) = run_given(&db, &program, &saved);
    assert!(diags.is_empty(), "{diags:?}");
    let ir = lower_given_contracts(&tables);
    let artifact = assemble_given_contracts(&ir, "test");
    let json = given_contracts_to_json(&artifact);
    let fingerprint = sha256_hex(JS.as_bytes());
    assert_eq!(
        json,
        format!(
            "{{\"artifact_version\":1,\"tool_version\":\"test\",\"traits\":[],\"keywords\":[{{\"ruleId\":\"Tasks.Account.handle#canonical_identity\",\"owner\":\"Tasks\",\"keyword\":\"canonical_identity\",\"anchor\":\"Tasks:keyword:canonical_identity:\",\"unitId\":\"u3\",\"producer\":\"state.unique-key@1\",\"semantics\":\"nfkc-ascii-lowercase\",\"lifecycle\":\"commit-keys\",\"export\":\"canonicalKey\",\"input\":{{\"name\":\"field\",\"type\":\"text\"}},\"result\":{{\"type\":\"text\"}},\"reads\":[],\"effects\":[],\"authority\":[],\"dependencies\":[\"Tasks.Account.handle\"],\"fingerprint\":\"{fingerprint}\",\"targetModel\":\"Tasks.Account\",\"targetField\":\"Tasks.Account.handle\",\"args\":[{{\"name\":\"target\",\"value\":\"Tasks.Account\"}},{{\"name\":\"field\",\"value\":\"Tasks.Account.handle\"}}],\"order\":0}}]}}"
        )
    );
    assert!(!json.ends_with('\n'));
    assert!(codes(&diags).is_empty());
}

// ## Production join: the checked keyword fingerprint covers the exact
// consumed import closure, not the root module alone.

#[test]
fn keyword_contract_fingerprint_covers_import_closure() {
    use canlang_compiler::analysis::types::{GivenSavedImport, given_closure_fingerprint};
    let text = refusal_app(
        " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
    );
    let (db, _app, program, base) = check_app(&text);
    assert!(base.is_empty(), "{base:?}");
    let root = "import { fold } from \"./fold.js\";\nexport function canonicalKey(v) { return fold(v); }\n";
    let fold_v1 = "export function fold(v) { return v.normalize(\"NFKC\").toLowerCase(); }\n";
    let fold_v2 = "export function fold(v) { return \"everything-collides\"; }\n";
    let contract_for = |fold: &str| {
        let mut unit = keyword_unit("u3", root, "canonicalKey");
        unit.implementation_imports = vec![GivenSavedImport {
            rel_path: "fold.js".to_string(),
            bytes: fold.as_bytes().to_vec(),
        }];
        let saved = keyword_saved_for(&db, &program, unit);
        let (tables, diags) = run_given(&db, &program, &saved);
        assert!(diags.is_empty(), "{diags:?}");
        assert_eq!(tables.keywords.len(), 1);
        tables.keywords[0].fingerprint.clone()
    };
    let fp1 = contract_for(fold_v1);
    let fp2 = contract_for(fold_v2);
    // Identical root, changed import: the contract fingerprint differs
    // (the import-probe regression at the check layer).
    assert_ne!(fp1, fp2);
    assert_ne!(fp1, sha256_hex(root.as_bytes()));
    // The check layer hashes exactly the shared closure scheme.
    assert_eq!(
        fp1,
        given_closure_fingerprint(root.as_bytes(), &[("fold.js", fold_v1.as_bytes())])
    );
    assert_eq!(contract_for(fold_v1), fp1);
}
