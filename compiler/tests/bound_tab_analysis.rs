//! Bound panel headers use only their owning preference's exact enum cases.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::path::Path;

const SOURCE: &str = r#"app BoundPanels
Given
When
Then
 preferences {view:enum(discovery,assignments)=discovery}
 page / title="Volunteering"
  tabs preferences.view
   tab discovery
    text "Published activities"
   tab assignments
    require authenticated
    text "Own assignments"
"#;

fn check(source: &str) -> (CheckedProgram, Vec<Diagnostic>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add("bound-panels.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    check_program(&db, &[id], catalog.as_ref())
}

fn claimed_at(checked: &CheckedProgram, source: &str, needle: &str) -> bool {
    let start = source.find(needle).unwrap() + "tab ".len();
    checked
        .types
        .resolved_cases
        .iter()
        .any(|key| key.start as usize <= start && key.end as usize > start)
}

#[test]
fn exact_bound_cases_claim_the_selector_enum_without_changing_original_volunteer() {
    let (checked, diagnostics) = check(SOURCE);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(claimed_at(&checked, SOURCE, "tab discovery"));
    assert!(claimed_at(&checked, SOURCE, "tab assignments"));
    let original = include_str!("../../draft/CanVolunteer.can");
    assert_eq!(
        sha256_hex(original.as_bytes()),
        "f9d6ba874fcbe5c60e064cb17628308be6f523d4dee31b53d95cda2ad0cdcff0"
    );
    assert!(original.contains("    tab assignments\n     require authenticated\n"));
    let (checked, diagnostics) = check(original);
    for (start, end) in [(22363, 22372), (22766, 22777)] {
        assert!(
            !diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E2001"
                    && diagnostic.primary.start == start
                    && diagnostic.primary.end == end),
            "{diagnostics:?}"
        );
        assert!(
            checked
                .types
                .resolved_cases
                .iter()
                .any(|key| key.start <= start && key.end >= end)
        );
    }
    assert!(
        !diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3001"
                && diagnostic.primary.start >= 22326
                && diagnostic.primary.end <= 22778),
        "{diagnostics:?}"
    );
}

#[test]
fn unknown_duplicate_and_missing_bound_cases_are_refused() {
    for (source, message) in [
        (
            SOURCE.replace("tab discovery", "tab unknown_case"),
            "exact case",
        ),
        (
            SOURCE.replace("tab assignments", "tab discovery"),
            "repeats case",
        ),
        (
            SOURCE.replace(
                "   tab assignments\n    require authenticated\n    text \"Own assignments\"\n",
                "",
            ),
            "missing assignments",
        ),
    ] {
        let (_, diagnostics) = check(&source);
        assert!(
            diagnostics.iter().any(
                |diagnostic| diagnostic.code == "E3001" && diagnostic.message.contains(message)
            ),
            "{message}: {diagnostics:?}"
        );
    }
    let (_, diagnostics) = check(&SOURCE.replace("tab discovery", "tab unknown_case"));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E2001"
                && diagnostic.message.contains("unknown_case")),
        "{diagnostics:?}"
    );
    let (_, diagnostics) = check(&SOURCE.replace("tab discovery", "tab \"discovery\""));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3001"
                && diagnostic.message.contains("exact case")),
        "quoted captions cannot replace bound case identities: {diagnostics:?}"
    );
}

#[test]
fn lexical_role_shadows_a_case_but_closed_builtin_spelling_can_be_a_case() {
    let source = SOURCE.replace("Given\n", "Given\n role discovery\n");
    let (checked, diagnostics) = check(&source);
    assert!(
        !claimed_at(&checked, &source, "tab discovery"),
        "a role is a real lexical binding"
    );
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3001"
                && diagnostic.message.contains("exact case")),
        "{diagnostics:?}"
    );
    assert!(
        !diagnostics.iter().any(
            |diagnostic| diagnostic.code == "E2001" && diagnostic.message.contains("discovery")
        ),
        "{diagnostics:?}"
    );
    let source = SOURCE.replace("discovery", "all");
    let (checked, diagnostics) = check(&source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(claimed_at(&checked, &source, "tab all"));
}

#[test]
fn bound_blocks_refuse_business_nullable_and_non_enum_selectors() {
    for source in [
        SOURCE.replace(
            "preferences {view:enum(discovery,assignments)=discovery}",
            "preferences {view:enum(discovery,assignments)?}",
        ),
        SOURCE.replace(
            "preferences {view:enum(discovery,assignments)=discovery}",
            "preferences {view:text=\"discovery\"}",
        ),
        SOURCE
            .replace(
                "Given\n",
                "Given\n Item {view:enum(discovery,assignments)=discovery}\n",
            )
            .replace("  tabs preferences.view", "  list Item\n   tabs row.view")
            .replace("   tab ", "    tab ")
            .replace("    text ", "     text ")
            .replace("    require ", "     require "),
    ] {
        let (_, diagnostics) = check(&source);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E3001"
                    && diagnostic
                        .message
                        .contains("owned nonnullable enum preference")),
            "{diagnostics:?}"
        );
    }
}

#[test]
fn owned_borrowed_and_grouped_enum_selectors_retain_their_exact_cases() {
    let source = SOURCE
        .replace(
            "Given\n",
            "Given\n Item {state:enum(discovery,assignments)=discovery}\n",
        )
        .replace("view:enum(discovery,assignments)", "view:Item.state")
        .replace("tabs preferences.view", "tabs ((preferences.view))");
    let (checked, diagnostics) = check(&source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(claimed_at(&checked, &source, "tab discovery"));
    assert!(claimed_at(&checked, &source, "tab assignments"));
}

#[test]
fn direct_case_expectation_does_not_leak_into_transient_panels_or_nested_bound_tabs() {
    let source = SOURCE.replace("    text \"Published activities\"", "    tabs\n     tab \"Nested caption\"\n      text \"Nested body\"")
        .replace("preferences {view:enum(discovery,assignments)=discovery}", "preferences {view:enum(discovery,assignments)=discovery,inner:enum(first,second)=first}")
        .replace("    text \"Own assignments\"", "    tabs preferences.inner\n     tab first\n      text \"First\"\n     tab second\n      text \"Second\"");
    let (checked, diagnostics) = check(&source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for header in [
        "tab discovery",
        "tab assignments",
        "tab first",
        "tab second",
    ] {
        assert!(claimed_at(&checked, &source, header));
    }
    assert!(!claimed_at(&checked, &source, "tab \"Nested caption\""));
    let leaf = SOURCE.replace("   tab discovery\n    text \"Published activities\"\n   tab assignments\n    require authenticated\n    text \"Own assignments\"\n", "");
    let (_, diagnostics) = check(&leaf);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let transient = "app Transient\nGiven\n message caption=\"Named caption\"@{}\nWhen\nThen\n page / title=\"Page\"\n  tabs\n   tab caption\n    text \"Content\"\n   tab \"Literal\"\n    text \"Other\"\n";
    let (_, diagnostics) = check(transient);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
}

#[test]
fn original_tab_gate_narrowing_is_local_to_its_own_body() {
    let source = SOURCE
        .replace("Given\n", "Given\n Place {name:text}\n")
        .replace(
            "preferences {view:enum(discovery,assignments)=discovery}",
            "preferences {view:enum(discovery,assignments)=discovery,place:Place?}",
        )
        .replace(
            "    require authenticated\n    text \"Own assignments\"",
            "    require preferences.place!=null\n    text preferences.place.name",
        );
    let (_, diagnostics) = check(&source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let ungated = source.replace(
        "    text \"Published activities\"",
        "    text preferences.place.name",
    );
    let (_, diagnostics) = check(&ungated);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3003"),
        "{diagnostics:?}"
    );
}
