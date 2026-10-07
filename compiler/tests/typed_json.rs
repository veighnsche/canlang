//! Independent outcome witnesses for the output-only shared Serde adapter.
use canlang_compiler::json::to_compact_string;
use serde::{Serialize, Serializer};

#[test]
fn typed_order_omission_null_and_exact_strings() {
    #[derive(Serialize)]
    struct Output<'a> {
        z: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        absent: Option<&'a str>,
        explicit_null: Option<&'a str>,
        empty: &'a str,
        decimal: &'a str,
        duration: &'a str,
    }
    let value = Output {
        z: "\u{8}\u{c}\n\r\t\"\\/é😀\u{2028}\u{2029}",
        absent: None,
        explicit_null: None,
        empty: "",
        decimal: "12345678901234567890.1200",
        duration: "9223372036854775807",
    };
    assert_eq!(
        to_compact_string(&value).unwrap(),
        concat!(
            "{\"z\":\"\\u0008\\u000c\\n\\r\\t\\\"\\\\/é😀\u{2028}\u{2029}\",",
            "\"explicit_null\":null,\"empty\":\"\",",
            "\"decimal\":\"12345678901234567890.1200\",",
            "\"duration\":\"9223372036854775807\"}"
        )
    );
}

#[test]
fn serialization_errors_are_reported_without_fallback_output() {
    struct Failing;
    impl Serialize for Failing {
        fn serialize<S: Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("independent failure witness"))
        }
    }
    assert_eq!(
        to_compact_string(&Failing).unwrap_err().to_string(),
        "independent failure witness"
    );
}

#[test]
fn qualified_raw_fragments_preserve_exact_scalar_spellings() {
    #[derive(Serialize)]
    struct Wrapped<'a> {
        value: &'a serde_json::value::RawValue,
    }
    for raw in [
        "null",
        "-0",
        "1e0",
        "1.0",
        "1e999999",
        "\"12345678901234567890.1200\"",
        "{\"minor\":\"9223372036854775807\",\"currency\":\"EUR\"}",
    ] {
        let value = serde_json::from_str::<&serde_json::value::RawValue>(raw).unwrap();
        assert_eq!(
            to_compact_string(&Wrapped { value }).unwrap(),
            format!("{{\"value\":{raw}}}")
        );
    }
    let huge = "9".repeat(400);
    let value = serde_json::from_str::<&serde_json::value::RawValue>(&huge).unwrap();
    assert_eq!(
        to_compact_string(&Wrapped { value }).unwrap(),
        format!("{{\"value\":{huge}}}")
    );
    for invalid in ["not-json", "01", "[1,]", "null null", "{"] {
        assert!(
            serde_json::from_str::<&serde_json::value::RawValue>(invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn raw_value_is_not_a_unicode_scalar_validator_and_input_parser_stays_strict() {
    // RawValue validates JSON grammar, where a lone escaped surrogate is
    // representable; it does not decode strings into Rust Unicode scalars.
    // Compiler-owned raw fragments come from serializers of valid Rust strings.
    let text = r#""\uD800""#;
    assert!(serde_json::from_str::<&serde_json::value::RawValue>(text).is_ok());
    assert!(canlang_compiler::json::parse(text).is_err());
}
