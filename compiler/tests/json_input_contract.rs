//! Independent input expectations, shared by catalog and LSP callers.
use canlang_compiler::json::{Json, MAX_JSON_DEPTH, parse, render};

#[test]
fn ordered_decoded_duplicates_and_marker_objects_are_ordinary_values() {
    let value = parse(r#"{"x":1,"\u0078":2,"$serde_json::private::Number":"123","$serde_json::private::RawValue":"[1]"}"#).unwrap();
    assert_eq!(
        value,
        Json::Obj(vec![
            ("x".into(), Json::Num("1".into())),
            ("x".into(), Json::Num("2".into())),
            (
                "$serde_json::private::Number".into(),
                Json::Str("123".into())
            ),
            (
                "$serde_json::private::RawValue".into(),
                Json::Str("[1]".into())
            ),
        ])
    );
    assert_eq!(value.get("x"), Some(&Json::Num("1".into())));
    for text in [
        r#"{"$serde_json::private::Number":"123"}"#,
        r#"{"$serde_json::private::RawValue":"[1]"}"#,
    ] {
        assert!(matches!(parse(text).unwrap(), Json::Obj(_)));
        assert_eq!(render(&parse(text).unwrap()), text);
    }
}

#[test]
fn number_lexemes_and_lexical_integer_accessor_stay_distinct() {
    for raw in [
        "-0",
        "-0.0",
        "1.0",
        "1e0",
        "1E+999999999999999999999",
        "0e-999999999999999999999",
        "9223372036854775808",
    ] {
        let value = parse(raw).unwrap();
        assert_eq!(value, Json::Num(raw.into()));
        assert_eq!(render(&value), raw);
        assert_eq!(value.as_i64(), if raw == "-0" { Some(0) } else { None });
    }
    let huge = "9".repeat(400);
    assert_eq!(parse(&huge).unwrap(), Json::Num(huge.clone()));
    assert_eq!(render(&parse(&huge).unwrap()), huge);
    for (raw, expected) in [
        ("9223372036854775807", i64::MAX),
        ("-9223372036854775808", i64::MIN),
        ("42", 42),
    ] {
        assert_eq!(parse(raw).unwrap().as_i64(), Some(expected));
    }
}

#[test]
fn heterogeneous_whitespace_unicode_and_number_looking_strings() {
    let value =
        parse(" \r\n[ true, false, null, \"1e999\", {\"é\":\"あ😀\\uD83D\\uDE00\"}, [] ]\t")
            .unwrap();
    assert_eq!(
        value,
        Json::Arr(vec![
            Json::Bool(true),
            Json::Bool(false),
            Json::Null,
            Json::Str("1e999".into()),
            Json::Obj(vec![("é".into(), Json::Str("あ😀😀".into()))]),
            Json::Arr(vec![])
        ])
    );
    assert_eq!(
        render(&value),
        r#"[true,false,null,"1e999",{"é":"あ😀😀"},[]]"#
    );
}

#[test]
fn malformed_grammar_and_strings_reject_with_byte_anchors() {
    for text in [
        "",
        "01",
        "-01",
        "+1",
        "1.",
        "1e",
        "1e+",
        "NaN",
        "Infinity",
        "true false",
        "[1,]",
        "{\"x\":1,}",
        "\u{a0}null",
        r#""\uD800""#,
        r#""\uDC00""#,
        r#""\uD800\u0041""#,
        r#"{"\uD800":0}"#,
        r#""\q""#,
        "\"é\n\"",
        "\"é\"\n x",
    ] {
        let error = parse(text).unwrap_err();
        assert!(error.offset <= text.len(), "{text:?}: {error:?}");
        assert!(error.to_string().starts_with("invalid JSON"));
    }
}

#[test]
fn depth_is_value_entry_depth_including_empty_deepest_containers() {
    assert_eq!(MAX_JSON_DEPTH, 64);
    for terminal in ["0", "[]", "{}"] {
        for depth in [63, 64, 65] {
            let text = format!("{}{}{}", "[".repeat(depth), terminal, "]".repeat(depth));
            assert_eq!(
                parse(&text).is_ok(),
                depth <= 64,
                "{depth} outer arrays around {terminal}"
            );
            let text = format!(
                "{}{}{}",
                "{\"x\":".repeat(depth),
                terminal,
                "}".repeat(depth)
            );
            assert_eq!(
                parse(&text).is_ok(),
                depth <= 64,
                "{depth} outer objects around {terminal}"
            );
        }
    }
}

#[test]
fn framing_body_limit_remains_independent_of_json_depth() {
    assert_eq!(
        canlang_compiler::lsp::transport::MAX_MESSAGE_BYTES,
        64 << 20
    );
}
