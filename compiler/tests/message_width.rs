//! Finite flat-message width qualification; no runtime or performance limit claim.
use canlang_compiler::analysis::types::{ResolvedType, Scalar};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn check(source: &str) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let file = db.add("message-width.can".into(), source.into());
    check_program(&db, &[file], None)
}

fn assert_literal_error(source: &str, pattern: &str, code: &str, message: &str) {
    let (_, diagnostics) = check(source);
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.code, code);
    assert_eq!(diagnostic.message, message);
    let literal = format!("\"{pattern}\"");
    let start = source.find(&literal).unwrap();
    assert_eq!(diagnostic.primary.start as usize, start);
    assert_eq!(diagnostic.primary.end as usize, start + literal.len());
}

#[test]
fn flat_named_message_width_preserves_owner_and_last_error_precision() {
    // Exact selectors remain digit strings; this value exceeds native numeric
    // ranges without asking the accepted profile to parse a numeric value.
    let exact = "9".repeat(512);
    for width in [100, 1000, 3000] {
        let plural_choices = (0..width)
            .map(|index| format!("={index} {{Case {index}}} "))
            .collect::<String>();
        let translated_plural_choices = (0..width)
            .rev()
            .map(|index| format!("={index} {{Keuze {index}}} "))
            .collect::<String>();
        let plural = format!("{{n,plural,{plural_choices}={exact} {{Large}} other {{Fallback}}}}");
        let translated_plural =
            format!("{{n,plural,{translated_plural_choices}={exact} {{Groot}} other {{Overig}}}}");
        let select_choices = (0..width)
            .map(|index| format!("k{index} {{Case {index}}} "))
            .collect::<String>();
        let select = format!("{{mode,select,{select_choices}other {{Fallback}}}}");
        let translated_select = format!("{{mode,select,{select_choices}other {{Overig}}}}");
        let signature = (0..width)
            .map(|index| format!("p{index}:text"))
            .collect::<Vec<_>>()
            .join(",");
        let placeholders = (0..width)
            .map(|index| format!("{{p{index}}}"))
            .collect::<String>();
        let translated_placeholders = (0..width)
            .rev()
            .map(|index| format!("{{p{index}}}"))
            .collect::<String>();
        let source = format!(
            "app MessageWidth\nGiven\n message plural(n:int) = \"{plural}\"@{{nl=\"{translated_plural}\"}}\n message choice(mode:text) = \"{select}\"@{{nl=\"{translated_select}\"}}\n message many({signature}) = \"{placeholders}\"@{{nl=\"{translated_placeholders}\"}}\nWhen\nThen\n"
        );
        let (checked, diagnostics) = check(&source);
        assert!(diagnostics.is_empty(), "width {width}: {diagnostics:?}");
        for (name, pattern, translated, count) in [
            ("plural", plural.as_str(), translated_plural.as_str(), 1),
            ("choice", select.as_str(), translated_select.as_str(), 1),
            (
                "many",
                placeholders.as_str(),
                translated_placeholders.as_str(),
                width,
            ),
        ] {
            let symbol = checked
                .symbols
                .iter()
                .find(|symbol| symbol.canonical == format!("MessageWidth.{name}"))
                .unwrap();
            let message = &checked.effects.messages[&symbol.id];
            assert_eq!(message.source, pattern);
            assert_eq!(message.source_lang, "en");
            assert_eq!(message.variants.len(), 1);
            assert_eq!(message.variants[0].locale, "nl");
            assert_eq!(message.variants[0].value.as_deref(), Some(translated));
            assert_eq!(message.params.len(), count);
            for (index, param) in message.params.iter().enumerate() {
                let parameter = &checked.symbols[param.param.0 as usize];
                let (expected_name, scalar) = match name {
                    "plural" => ("n".to_string(), Scalar::Int),
                    "choice" => ("mode".to_string(), Scalar::Text),
                    _ => (format!("p{index}"), Scalar::Text),
                };
                assert_eq!(parameter.name, expected_name);
                assert_eq!(
                    checked.types.symbol_types[&param.param],
                    ResolvedType::Scalar(scalar)
                );
            }
        }
        let duplicate =
            translated_plural.replace("other {Overig}", "=0 {Last duplicate} other {Overig}");
        let invalid = source.replace(
            &format!("nl=\"{translated_plural}\""),
            &format!("nl=\"{duplicate}\""),
        );
        assert_literal_error(
            &invalid,
            &duplicate,
            "E5007",
            "invalid message pattern: duplicate '=0' branch",
        );
        let unknown = translated_select.replace(
            &format!("k{} {{Case {}}}", width - 1, width - 1),
            &format!("k{} {{Last {{missing}}}}", width - 1),
        );
        let invalid = source.replace(
            &format!("nl=\"{translated_select}\""),
            &format!("nl=\"{unknown}\""),
        );
        assert_literal_error(
            &invalid,
            &unknown,
            "E3016",
            "message placeholder '{missing}' names no message parameter",
        );
    }
}
