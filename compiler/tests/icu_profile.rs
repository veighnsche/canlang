//! Finite compiler consumers of the approved bounded ICU grammar and usages.
//!
//! These authored Rust/Can strings cover Unicode scalar values. The shared TS
//! corpus's lone-surrogate case is outside this domain; this is not a UTF16
//! transport test. Keep public TS string-domain coverage with the TS owners.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::check::{
    GivenContractInputs, GivenSavedUnit, check_given_contracts,
};
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::generation::{GenerationKind, discover_program};
use canlang_compiler::analysis::generation_intake::{AssociationKey, UnitKind};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use std::collections::HashMap;
use std::path::Path;

fn check_source(source: &str, catalog: Option<&Catalog>) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let file = db.add("icu-profile.can".into(), source.into());
    let diagnostics = check_program(&db, &[file], catalog).1;
    assert!(
        diagnostics.iter().all(|d| !d.code.starts_with("E1")),
        "semantic case must parse: {source}\n{diagnostics:?}"
    );
    diagnostics
}

fn literal(pattern: &str) -> String {
    serde_json::to_string(pattern).unwrap()
}

fn named(signature: &str, authored: &str, translated: bool) -> String {
    let value = if translated {
        format!("\"Source\"@{{nl={authored},fr=null}}")
    } else {
        format!("{authored}@{{}}")
    };
    format!("app ICU\nGiven\n message m{signature} = {value}\nWhen\nThen\n")
}

fn assert_literal_error(source: &str, authored: &str, code: &str) -> Vec<Diagnostic> {
    let diagnostics = check_source(source, None);
    assert_eq!(diagnostics.len(), 1, "{source}\n{diagnostics:?}");
    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.code, code, "{diagnostics:?}");
    let start = source.find(authored).unwrap();
    assert_eq!(diagnostic.primary.start as usize, start);
    assert_eq!(diagnostic.primary.end as usize, start + authored.len());
    diagnostics
}

fn catalog() -> Catalog {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let file = db.add("catalog-anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

#[test]
fn valid_usage_discovery_follows_quotes_whitespace_and_all_branches() {
    for pattern in [
        "Don't {ghost}",
        "{ ghost }",
        "{s,select,a{ok} other{{ghost}}}",
    ] {
        for translated in [false, true] {
            let authored = literal(pattern);
            let source = named("(s:text)", &authored, translated);
            let diagnostics = assert_literal_error(&source, &authored, "E3016");
            assert!(diagnostics[0].message.contains("{ghost}"));
        }
    }
    for pattern in [
        "Don't {n}",
        "It''s {n}",
        "'{ghost}' { n }",
        "{ n , plural , one{one} other{{ s , select , active-case{word} other{{n}}}}}",
    ] {
        let source = named("(n:int,s:text)", &literal(pattern), false);
        assert!(check_source(&source, None).is_empty(), "{source}");
    }
    // Numeric keys are grammar names, not Can positional bindings.
    let authored = literal("{0}");
    assert_literal_error(&named("", &authored, false), &authored, "E3016");
}

#[test]
fn approved_grammar_accepts_finite_lexical_changes() {
    for pattern in [
        "Issue #42 '|' '|",
        "'{''}' '{<b>}' a < b > c; <3; <>",
        "😀 {name} 🚀",
        "{\u{feff}n\u{feff},\u{feff}number\u{feff}}",
        "{\t\r\n\u{a0}\u{1680}\u{2000}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}n}",
        "{n,plural,zero{0} one{1} two{2} few{f} many{m} other{o}}",
        "{n,plural,=01.00{one} =000.5000{half} =9007199254740993{large} other{#}}",
        "{s,select,active-case{a} 1{b} -{c} other{d}}",
        "{n,plural,other{{s,select,other{# {m,plural,other{#}}}}}}",
    ] {
        for translated in [false, true] {
            let source = named(
                "(n:int,m:int,s:text,name:text)",
                &literal(pattern),
                translated,
            );
            let diagnostics = check_source(&source, None);
            assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
        }
    }
}

#[test]
fn malformed_patterns_leave_syntax_ownership_without_speculative_slots() {
    for pattern in [
        "Don't {ghost",
        "{ ghost",
        "{é}",
        "{\u{85}n}",
        "{n,plural,=-1{{ghost}} other{x}}",
        "{s,select,other{{ghost}}",
        "<b>{ghost}</b>",
    ] {
        for translated in [false, true] {
            let authored = literal(pattern);
            assert_literal_error(
                &named("(n:int,s:text)", &authored, translated),
                &authored,
                "E5007",
            );
        }
        // Static page checks consume the same valid-only usage result.
        let source = format!(
            "app ICU\nGiven\nWhen\nThen\n page / title={}@{{}}\n",
            literal(pattern)
        );
        let diagnostics = check_source(&source, None);
        assert!(
            diagnostics.iter().any(|d| d.code == "E5007"),
            "{diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|d| d.code != "E3013" && d.code != "E3016"),
            "{diagnostics:?}"
        );
    }
}

#[test]
fn refused_categories_select_keys_tags_and_exact_selectors_are_syntax_errors() {
    for pattern in [
        "{n,plural,banana{x} other{y}}",
        "{n,plural,One{x} other{y}}",
        "{n,plural,=-1{x} other{y}}",
        "{n,plural,=+1{x} other{y}}",
        "{n,plural,=.5{x} other{y}}",
        "{n,plural,=1.{x} other{y}}",
        "{n,plural,=1e2{x} other{y}}",
        "{n,plural,=01.00{x} =1{y} other{z}}",
        "{n,plural,=9007199254740993{x} =09007199254740993.0{y} other{z}}",
        "{s,select,=1{x} other{y}}",
        "{s,select,a.b{x} other{y}}",
        "{s,select,é{x} other{y}}",
        "{n,plural,one{x} offset:0 other{y}}",
        "<b>{n}</b>",
        "<x/>",
        "<x title='a'>",
        "</x>",
    ] {
        let authored = literal(pattern);
        assert_literal_error(
            &named("(n:int,s:text)", &authored, false),
            &authored,
            "E5007",
        );
    }
    // Whole authored byte spans survive decoding, for source and variants.
    let authored = r#""<b>{\u006e}</b>""#;
    for translated in [false, true] {
        assert_literal_error(&named("(n:int)", authored, translated), authored, "E5007");
    }
}

#[test]
fn depth_limit_counts_each_argument_before_descent() {
    for (levels, leaf, accepted) in [
        (32, "text", true),
        (33, "text", false),
        (31, "{n}", true),
        (32, "{n}", false),
        (256, "text", false),
    ] {
        let pattern = format!(
            "{}{}{}",
            "{n,plural,other{".repeat(levels),
            leaf,
            "}}".repeat(levels)
        );
        let authored = literal(&pattern);
        let source = named("(n:int)", &authored, false);
        if accepted {
            let diagnostics = check_source(&source, None);
            assert!(diagnostics.is_empty(), "{levels}/{leaf}: {diagnostics:?}");
        } else {
            let diagnostics = assert_literal_error(&source, &authored, "E5007");
            assert!(
                diagnostics[0].message.contains("too deep"),
                "{diagnostics:?}"
            );
        }
    }
}

#[test]
fn typed_dual_faults_keep_existing_checkpoint_order() {
    for (pattern, ty, reason) in [
        (
            "{n,number,short}",
            "text",
            "unsupported number style 'short'",
        ),
        ("{n,date,xx}", "int", "incompatible type"),
        ("{n,time,xx}", "date", "incompatible type"),
        ("{n,plural banana{x}}", "text", "incompatible type"),
        (
            "{n,selectordinal banana{x}}",
            "decimal",
            "incompatible type",
        ),
        ("{n,select banana{x}}", "int", "incompatible type"),
    ] {
        for translated in [false, true] {
            let authored = literal(pattern);
            let source = named(&format!("(n:{ty})"), &authored, translated);
            let diagnostics = assert_literal_error(&source, &authored, "E5007");
            assert!(diagnostics[0].message.contains(reason), "{diagnostics:?}");
        }
    }
}

#[test]
fn anonymous_selected_aliases_use_shared_grammar_and_declaration_checkpoint() {
    let catalog = catalog();
    for (descriptor, expected) in [
        ("\"Don't { n } '| #\"@{}(n=1)", None),
        (
            "\"source\"@{nl=\"{ n , plural , =1.5{one} other{#}}\"}(n=1)",
            None,
        ),
        ("\"{ghost!\"@{}", Some("undeclared variable {ghost}")),
        (
            "\"source\"@{nl=\"{ghost!\"}",
            Some("undeclared variable {ghost}"),
        ),
        (
            "choose(true,\"Issue #42 '|\"@{},\"Don't { n }\"@{}(n=1))",
            None,
        ),
        (
            "choose(true,\"Hi\"@{},\"{ghost!\"@{})",
            Some("undeclared variable {ghost}"),
        ),
        (
            "choose(true,\"Hi\"@{},choose(false,\"Bye\"@{},\"source\"@{nl=\"{ghost!\"}))",
            Some("undeclared variable {ghost}"),
        ),
    ] {
        let source = format!(
            "app ICU\nGiven\nWhen\n scenario run() by=members\n  do\n   let descriptor={descriptor}\n   let alias=((descriptor))\n   let rendered=format(locale=null,descriptor=alias)\nThen\n"
        );
        let diagnostics = check_source(&source, Some(&catalog));
        if let Some(reason) = expected {
            assert_eq!(diagnostics.len(), 1, "{source}\n{diagnostics:?}");
            assert_eq!(diagnostics[0].code, "E5007");
            assert!(diagnostics[0].message.contains(reason), "{diagnostics:?}");
        } else {
            assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
        }
    }
    let machine =
        "app ICU\nGiven\n derive value():text = format(\"{d}\",{d=\"plain\"})\nWhen\nThen\n";
    assert!(check_source(machine, Some(&catalog)).is_empty());
}

#[test]
fn anonymous_bound_dual_faults_keep_inferred_schema_and_single_syntax_diagnostic() {
    let catalog = catalog();
    for (pattern, binding, reason) in [
        (
            "{n,number,short}",
            "n=\"one\"",
            "unsupported number style 'short'",
        ),
        ("{n,date,xx}", "n=1", "incompatible type"),
        ("{n,time,xx}", "n=2026-10-09", "incompatible type"),
        ("{n,plural banana{x}}", "n=\"one\"", "incompatible type"),
        ("{n,selectordinal banana{x}}", "n=1.5", "incompatible type"),
        ("{n,select banana{x}}", "n=1", "incompatible type"),
        (
            "{n,plural,one{x}}",
            "n=1",
            "plural and select need an 'other' branch",
        ),
    ] {
        for translated in [false, true] {
            let authored = literal(pattern);
            let descriptor = if translated {
                format!("\"Source\"@{{nl={authored}}}({binding})")
            } else {
                format!("{authored}@{{}}({binding})")
            };
            let source = format!(
                "app ICU\nGiven\n derive value():text = format({descriptor},locale=null)\nWhen\nThen\n"
            );
            let diagnostics = check_source(&source, Some(&catalog));
            assert_eq!(diagnostics.len(), 1, "{source}\n{diagnostics:?}");
            let diagnostic = &diagnostics[0];
            assert_eq!(diagnostic.code, "E5007", "{diagnostics:?}");
            assert!(diagnostic.message.contains(reason), "{diagnostics:?}");
            let start = source.find(&authored).unwrap();
            assert_eq!(diagnostic.primary.start as usize, start);
            assert_eq!(diagnostic.primary.end as usize, start + authored.len());
        }
    }
}

#[test]
fn anonymous_valid_patterns_still_reject_extra_bindings() {
    let catalog = catalog();
    for descriptor in [
        "\"{n}\"@{}(n=1,extra=2)",
        "\"Source\"@{nl=\"{n}\"}(n=1,extra=2)",
    ] {
        let source = format!(
            "app ICU\nGiven\n derive value():text = format({descriptor},locale=null)\nWhen\nThen\n"
        );
        let diagnostics = check_source(&source, Some(&catalog));
        assert!(
            diagnostics.iter().any(|d| d.code == "E3005"),
            "{source}\n{diagnostics:?}"
        );
        assert!(
            diagnostics.iter().all(|d| d.code != "E5007"),
            "{source}\n{diagnostics:?}"
        );
    }
}

#[test]
fn contributed_static_captions_keep_declaration_before_delimiter_checks() {
    let mut db = SourceDb::new();
    let file = db.add("icu-static.can".into(), "app Tasks\nGiven\n trait marked $\"Add labeled fields.\"\n Account {handle:text} marked\nWhen\nThen\n".into());
    let (program, diagnostics) = check_program(&db, &[file], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let found = discover_program(&db, program.checked_files());
    let definition = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::NamedTrait)
        .unwrap();
    for (pattern, reason) in [
        ("Issue #42 '|", None),
        ("{ghost!", Some("undeclared variable {ghost}")),
    ] {
        let carrier = format!(
            "app Tasks\nGiven\n marked {{pinned:bool=false label={}}}\n",
            literal(pattern)
        );
        let carrier_id = db.add("can.generated/icu/contributions.can".into(), carrier);
        let saved = HashMap::from([(
            AssociationKey {
                owner: definition.owner.clone(),
                kind: UnitKind::NamedTrait,
                label: definition.label.clone(),
                anchor: definition.anchor.clone(),
            },
            GivenSavedUnit {
                unit_id: "icu".into(),
                contributions: Some(carrier_id),
                implementation_js: None,
                implementation_imports: Vec::new(),
                declaration: None,
            },
        )]);
        let (tables, diagnostics) = check_given_contracts(&GivenContractInputs {
            db: &db,
            program: &program,
            saved: &saved,
        });
        if let Some(reason) = reason {
            assert!(tables.traits.is_empty());
            assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
            assert_eq!(diagnostics[0].code, "E5007");
            assert!(diagnostics[0].message.contains(reason), "{diagnostics:?}");
        } else {
            assert!(diagnostics.is_empty(), "{diagnostics:?}");
            assert_eq!(
                tables.traits[0].contributed_fields[0].label.as_deref(),
                Some(pattern)
            );
        }
    }
}
