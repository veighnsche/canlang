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
    let original = include_str!("../../draft/apps/CanVolunteer/CanVolunteer.can");
    assert_eq!(
        sha256_hex(original.as_bytes()),
        "80fac88b1486b3d01becfd75dde1d7dda097f90c93c5fe8287890d106806bb68"
    );
    assert!(original.contains("    tab assignments\n     require authenticated\n"));
    let (checked, diagnostics) = check(original);
    for case in ["discovery", "assignments"] {
        let start = (original.find(&format!("tab {case}")).unwrap() + 4) as u32;
        let end = start + case.len() as u32;
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
                && diagnostic.primary.start
                    >= original.find("tabs preferences.view").unwrap() as u32
                && diagnostic.primary.end <= original.len() as u32),
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

#[test]
fn unguarded_bound_panels_require_original_checked_header_and_preference_facts() {
    use canlang_compiler::analysis::catalog::Catalog;
    use canlang_compiler::analysis::resolve::SymbolKind;
    use canlang_compiler::analysis::{ResolvedType, Scalar};
    use canlang_compiler::codegen::ir::{self, IrExpr, IrProgram, IrUi};
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    use canlang_compiler::diagnostic::DiagnosticResult;
    use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

    fn owned(source: &str) -> (SourceDb, CheckedProgram, Catalog) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut db = SourceDb::new();
        let file = db.add("bound-panels.can".into(), source.into());
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (checked, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, checked, catalog)
    }

    fn tabs(nodes: &[IrUi]) -> Vec<&IrUi> {
        let mut found = Vec::new();
        for node in nodes {
            if node.factory == "tabs" {
                found.push(node);
            }
            found.extend(tabs(&node.children));
        }
        found
    }

    fn bound_tabs(ir: &IrProgram) -> Vec<&IrUi> {
        ir.modules
            .iter()
            .flat_map(|module| &module.pages)
            .flat_map(|page| tabs(&page.render))
            .collect()
    }

    let source = SOURCE.replace("    require authenticated\n", "");
    let (db, checked, catalog) = owned(&source);
    let (valid, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let panels = bound_tabs(&valid);
    assert_eq!(panels.len(), 1);
    assert_eq!(panels[0].children.len(), 2);
    assert!(panels[0].props.iter().any(|(name, _)| name == "binding"));
    assert!(panels[0].children.iter().all(|panel| panel.gate.is_none()));
    for (panel, expected) in panels[0].children.iter().zip(["discovery", "assignments"]) {
        assert_eq!(panel.factory, "tabItem");
        assert!(panel.props.iter().any(|(name, value)| {
            name == "value" && matches!(&value.expr, IrExpr::Text(case) if case == expected)
        }));
    }

    for mutation in [
        "selector-type-removed",
        "selector-type-edited",
        "header-type-removed",
        "header-type-edited",
        "header-case-removed",
        "receiving-symbol",
        "receiving-owner",
        "receiving-type",
        "owning-module-name",
    ] {
        let (db, mut checked, catalog) = owned(&source);
        let selector = *checked
            .types
            .node_types
            .keys()
            .find(|key| source[key.start as usize..key.end as usize].trim() == "preferences.view")
            .expect("checked bound selector type");
        let header_start = source.find("tab discovery").unwrap() + "tab ".len();
        let header = *checked
            .types
            .resolved_cases
            .iter()
            .find(|key| key.start as usize <= header_start && key.end as usize > header_start)
            .expect("checked direct panel case");
        assert!(checked.types.node_types.contains_key(&header));
        let preferences = checked
            .symbols
            .iter()
            .find_map(|symbol| match &symbol.kind {
                SymbolKind::Preferences { fields } => Some(fields[0]),
                _ => None,
            })
            .expect("receiving preference field");
        match mutation {
            "selector-type-removed" => {
                checked.types.node_types.remove(&selector);
            }
            "selector-type-edited" => {
                checked
                    .types
                    .node_types
                    .insert(selector, ResolvedType::Scalar(Scalar::Text));
            }
            "header-type-removed" => {
                checked.types.node_types.remove(&header);
            }
            "header-type-edited" => {
                checked
                    .types
                    .node_types
                    .insert(header, ResolvedType::Scalar(Scalar::Text));
            }
            "header-case-removed" => {
                checked.types.resolved_cases.remove(&header);
            }
            "receiving-symbol" => {
                checked.symbols[preferences.0 as usize]
                    .canonical
                    .push_str("Edited");
            }
            "receiving-owner" => {
                let SymbolKind::Field { owner, .. } =
                    &mut checked.symbols[preferences.0 as usize].kind
                else {
                    panic!("receiving field");
                };
                *owner = preferences;
            }
            "receiving-type" => {
                checked
                    .types
                    .symbol_types
                    .insert(preferences, ResolvedType::Scalar(Scalar::Text));
            }
            "owning-module-name" => {
                checked.modules[0].name.push_str("Edited");
            }
            _ => unreachable!(),
        }
        let (refused, diagnostics) = ir::build(&checked, &db, Some(&catalog));
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mutation}: {diagnostics:?}"
        );
        assert!(bound_tabs(&refused).is_empty(), "{mutation}");
    }

    let mut result = DiagnosticResult::new("bound-panels", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.finish();
    for bytes in [
        source.clone(),
        source.replace("Own assignments", "Edited assignments"),
    ] {
        let mut foreign = SourceDb::new();
        foreign.add("bound-panels.can".into(), bytes);
        let (artifact, diagnostics) = emit(
            &checked,
            &EmitSources {
                db: &foreign,
                result: &result,
                catalog: Some(&catalog),
                options: EmitOptions::new(),
            },
        );
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6011"),
            "{diagnostics:?}"
        );
        assert!(artifact.modules.is_empty());
        assert!(artifact.pages.is_empty());
    }
}

#[test]
fn gated_bound_panels_lower_with_gates_and_authored_count() {
    use canlang_compiler::codegen::ir::{self, IrExpr, IrProgram, IrUi};
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    use canlang_compiler::diagnostic::DiagnosticResult;
    use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};

    // Full SOURCE keeps `require authenticated` on the assignments panel:
    // bound tabs with a direct tab gate must lower, not refuse E6008.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let file = db.add("bound-panels.can".into(), SOURCE.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (checked, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");

    let (valid, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    fn tabs(nodes: &[IrUi]) -> Vec<&IrUi> {
        let mut found = Vec::new();
        for node in nodes {
            if node.factory == "tabs" {
                found.push(node);
            }
            found.extend(tabs(&node.children));
        }
        found
    }
    fn panels_of(ir: &IrProgram) -> Vec<&IrUi> {
        ir.modules
            .iter()
            .flat_map(|module| &module.pages)
            .flat_map(|page| tabs(&page.render))
            .collect()
    }
    let panels = panels_of(&valid);
    assert_eq!(panels.len(), 1);
    assert!(panels[0].props.iter().any(|(name, _)| name == "binding"));
    assert_eq!(panels[0].children.len(), 2);
    // The gated panel carries its gate; the open panel carries none.
    for (panel, expected, gated) in panels[0]
        .children
        .iter()
        .zip(["discovery", "assignments"])
        .map(|(panel, expected)| (panel, expected, expected == "assignments"))
    {
        assert_eq!(panel.factory, "tabItem");
        assert!(panel.props.iter().any(|(name, value)| {
            name == "value" && matches!(&value.expr, IrExpr::Text(case) if case == expected)
        }));
        assert_eq!(panel.gate.is_some(), gated, "{expected}");
    }

    // The emitted items still report how many panels were authored so the
    // factory can tell all-gated from authored-empty at runtime.
    let mut result = DiagnosticResult::new("bound-panels", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(&db);
    result.finish();
    let (artifact, diagnostics) = emit(
        &checked,
        &EmitSources {
            db: &db,
            result: &result,
            catalog: Some(&catalog),
            options: EmitOptions::new(),
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let entry = artifact
        .modules
        .iter()
        .map(|module| module.js.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        entry.contains("authoredPanels:2"),
        "authored panel count reaches the factory"
    );
}
